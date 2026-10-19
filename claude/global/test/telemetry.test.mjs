// Tests for schema-2 telemetry: tree snapshots, worker/post-worker attribution, report parsing,
// assess/abandon/metrics in codex-delegate.mjs.
// Author: maintained with Claude Code for the frontier-model orchestration setup.
//
//   node --test claude/global/test/telemetry.test.mjs
//
// CLI tests stage the installed layout in a temp dir with a stub companion that edits the target
// repo like a worker would, so they never contact Codex and never touch real telemetry.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  snapshotTree, changedPaths, diffStat, parseWorkerReport, countListItems, looksLikeQuotaStop,
  groupMetrics, overlappingRuns, workerDuration
} from "../scripts/telemetry-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

/** Temp repo with one commit, plus a pre-existing uncommitted edit. Output: repo dir. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-repo-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.test");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "core.autocrlf", "false");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.js"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(dir, "notes.md"), "base\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(dir, "notes.md"), "base\nopus was here before the run\n");
  return dir;
}

const REPORT = [
  "Done.", "```yaml", "status: completed", "summary: added slugify", "files_changed: [src/a.js]",
  "checks_run:", "  - command: node --test", "    result: pass", "  - command: npm run lint", "    result: not-run",
  "unresolved_issues: []", "```"
].join("\n");

test("parseWorkerReport reads the final status and check results", () => {
  const r = parseWorkerReport(`status: partial\nnoise\n${REPORT}`);
  assert.equal(r.status, "completed");
  assert.deepEqual(r.checks, { pass: 1, fail: 0, not_run: 1 });
  assert.equal(r.checks_executed, true);
  assert.equal(parseWorkerReport("no report here"), null);
  const notRun = parseWorkerReport("status: blocked\nchecks_run:\n  - command: x\n    result: not-run\n");
  assert.equal(notRun.checks_executed, false);
});

test("countListItems and looksLikeQuotaStop", () => {
  assert.equal(countListItems("required_checks:\n  - node --test\n  - npm run build\n"), 2);
  assert.equal(countListItems(null), 0);
  assert.equal(looksLikeQuotaStop("Error: You've hit your usage limit"), true);
  assert.equal(looksLikeQuotaStop("tests failed"), false);
});

test("snapshotTree leaves index, refs, HEAD and status untouched", () => {
  const dir = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "untracked.txt"), "new\n");
    const before = [git(dir, "status", "--porcelain=v1"), git(dir, "rev-parse", "HEAD"), git(dir, "for-each-ref"), git(dir, "stash", "list")];
    const tree = snapshotTree(dir);
    assert.match(tree, /^[0-9a-f]{40}$/);
    const after = [git(dir, "status", "--porcelain=v1"), git(dir, "rev-parse", "HEAD"), git(dir, "for-each-ref"), git(dir, "stash", "list")];
    assert.deepEqual(after, before);
    assert.equal(snapshotTree(dir), tree, "same content gives the same tree");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("changedPaths and diffStat attribute only what changed between snapshots", () => {
  const dir = makeRepo();
  try {
    const base = snapshotTree(dir);
    fs.writeFileSync(path.join(dir, "src", "a.js"), "one\nTWO\nthree\nfour\n");
    fs.writeFileSync(path.join(dir, "src", "b.js"), "x\ny\n");
    fs.mkdirSync(path.join(dir, "ignored"));
    fs.writeFileSync(path.join(dir, "ignored", "big.bin"), "zzz");
    const worker = snapshotTree(dir);
    assert.deepEqual(changedPaths(dir, base, worker).sort(), ["src/a.js", "src/b.js"], "pre-existing dirt and ignored files excluded");
    assert.deepEqual(diffStat(dir, base, worker), { files: 2, lines_added: 4, lines_removed: 1, binary_files: 0 });
    fs.writeFileSync(path.join(dir, "src", "a.js"), "one\nTWO\nthree\nfive\n");
    fs.writeFileSync(path.join(dir, "notes.md"), "unrelated opus edit\n");
    const now = snapshotTree(dir);
    assert.deepEqual(diffStat(dir, worker, now, ["src/a.js", "src/b.js"]), { files: 1, lines_added: 1, lines_removed: 1, binary_files: 0 });
    assert.deepEqual(diffStat(dir, worker, now, []), { files: 0, lines_added: 0, lines_removed: 0, binary_files: 0 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("groupMetrics splits multi-cause runs and computes rewrite ratio", () => {
  const runs = [
    { run_id: "a", role: "luna-implement", worker_duration_ms: 6 * 60000, worker_patch: { lines_added: 80, lines_removed: 20 },
      post_worker: { measured: true, lines_added: 10, lines_removed: 10 },
      assessment: { outcome: "minor_rework", cause: ["test_gap", "spec_error"], verified: ["tests"] } },
    { run_id: "b", role: "luna-implement", worker_duration_ms: 20 * 60000,
      assessment: { outcome: "accepted", cause: [], verified: ["tests"] } },
    { run_id: "c", role: "astra-review", assessment: { outcome: "accepted" } }
  ];
  const byCause = Object.fromEntries(groupMetrics(runs, "cause").map((r) => [r.group, r]));
  assert.equal(byCause.test_gap.runs, 1);
  assert.equal(byCause.spec_error.runs, 1);
  assert.equal(byCause.none.runs, 2);
  const luna = groupMetrics(runs, "role").find((r) => r.group === "luna-implement");
  assert.equal(luna.rewrite_ratio, 0.2);
  assert.equal(luna.verified_accepted, 1);
  assert.deepEqual(groupMetrics(runs, "duration").map((r) => r.group).sort(), ["15-30m", "5-15m", "unknown"]);
  assert.throws(() => groupMetrics(runs, "nope"));
});

test("workerDuration ignores schema-1 background submission time", () => {
  assert.equal(workerDuration({ background: true, status: "submitted_background", duration_ms: 1500 }), null);
  assert.equal(workerDuration({ background: false, status: "completed", duration_ms: 1500 }), 1500);
  assert.equal(workerDuration({ background: true, worker_duration_ms: 9000, duration_ms: 1500 }), 9000);
});

test("overlappingRuns needs same repo, overlapping time and shared files", () => {
  const base = { git_root: "/r", started_at: "2026-10-20T10:00:00Z", finished_at: "2026-10-20T10:10:00Z", touched_files: ["/r/a"] };
  const runs = [
    { ...base, run_id: "me" },
    { ...base, run_id: "same-file" },
    { ...base, run_id: "other-file", touched_files: ["/r/b"] },
    { ...base, run_id: "later", started_at: "2026-10-20T12:00:00Z", finished_at: "2026-10-20T12:10:00Z" },
    { ...base, run_id: "other-repo", git_root: "/s" }
  ];
  assert.deepEqual(overlappingRuns(runs[0], runs, "2026-10-20T11:00:00Z"), ["same-file"]);
});

// --- CLI: stub companion that behaves like a worker editing src/a.js -------------------------

const STUB = `
import fs from "node:fs"; import path from "node:path";
const args = process.argv.slice(2); const cmd = args[0];
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const state = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\\/(\\w:)/, "$1")), "job.json");
const report = ${JSON.stringify(REPORT)};
if (cmd === "task") {
  const cwd = opt("--cwd");
  fs.writeFileSync(path.join(cwd, "src", "a.js"), "one\\ntwo\\nthree\\nworker1\\nworker2\\n");
  if (args.includes("--background")) {
    fs.writeFileSync(state, JSON.stringify({ startedAt: new Date(Date.now() - 60000).toISOString(), completedAt: new Date().toISOString() }));
    console.log("Submitted task-abc123-xyz9");
  } else console.log(report);
  process.exit(0);
}
if (cmd === "status") process.exit(0);
if (cmd === "result") {
  const s = JSON.parse(fs.readFileSync(state, "utf8"));
  console.log(JSON.stringify({ storedJob: { status: "completed", startedAt: s.startedAt, completedAt: s.completedAt,
    result: { status: 0, rawOutput: report, touchedFiles: ["reported-by-companion.js"] } } }));
  process.exit(0);
}
process.exit(1);
`;

function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-stage-"));
  for (const [src, dst] of [["shared", "shared"], ["codex", "codex"], ["claude/global/scripts", "scripts"], ["claude/global/config", "config"]]) {
    fs.cpSync(path.join(REPO, src), path.join(dir, dst), { recursive: true });
  }
  fs.rmSync(path.join(dir, "config", "models.local.json"), { force: true });
  const companion = path.join(dir, "stub-codex-companion.mjs");
  fs.writeFileSync(companion, STUB);
  const snap = path.join(dir, "snapshot.json");
  fs.writeFileSync(snap, JSON.stringify({ usedPercent: 0, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }));
  const wrapper = path.join(dir, "scripts", "codex-delegate.mjs");
  const cli = (...args) => spawnSync(process.execPath, [wrapper, ...args], {
    encoding: "utf8", env: { ...process.env, CODEX_COMPANION: companion, CODEX_QUOTA_SNAPSHOT: snap }
  });
  const runs = () => fs.readdirSync(path.join(dir, "runs")).filter((f) => f.endsWith(".run.json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, "runs", f), "utf8")));
  return { dir, cli, runs };
}

const packet = path.join(HERE, "T001-slugify.yaml");

test("foreground run records touched files, patch, report; assess measures post-worker rewrite", () => {
  const s = stage();
  const repo = makeRepo();
  try {
    const r = s.cli("run", "--role", "luna-implement", "--packet", packet, "--cwd", repo);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const [run] = s.runs();
    assert.equal(run.schema_version, 2);
    assert.equal(run.status, "completed");
    assert.equal(run.touched_files_source, "git");
    assert.deepEqual(run.touched_files, [path.join(run.git_root, "src/a.js")]);
    assert.deepEqual(run.worker_patch, { files: 1, lines_added: 2, lines_removed: 0, binary_files: 0 });
    assert.equal(run.worker_report.checks_executed, true);
    assert.equal(run.required_checks_count, 1);
    assert.ok(run.worker_duration_ms >= 0);
    assert.ok(run.dirty_before.includes("notes.md"), "pre-existing dirt recorded but not attributed");

    // Opus fixes one worker line and edits an unrelated file.
    fs.writeFileSync(path.join(repo, "src", "a.js"), "one\ntwo\nthree\nworker1\nfixed\n");
    fs.writeFileSync(path.join(repo, "notes.md"), "unrelated\n");
    const a = s.cli("assess", run.run_id, "--outcome", "minor_rework", "--useful", "yes", "--cause", "model_error,test_gap", "--verified", "tests");
    assert.equal(a.status, 0, a.stdout + a.stderr);
    const [assessed] = s.runs();
    assert.deepEqual(assessed.assessment.cause, ["model_error", "test_gap"]);
    assert.deepEqual(assessed.assessment.verified, ["tests"]);
    assert.equal(assessed.post_worker.measured, true);
    assert.equal(assessed.post_worker.files, 1);
    assert.equal(assessed.post_worker.lines_added + assessed.post_worker.lines_removed, 2);
    assert.equal(assessed.post_worker.rewrite_ratio, 1);
    assert.equal(assessed.post_worker.attribution, "clean");
    assert.match(a.stdout, /REWRITE: worker 2 lines in 1 files; changed afterwards 2 lines/);

    const byCause = s.cli("metrics", "--by", "cause", "--json");
    const rows = JSON.parse(byCause.stdout);
    assert.deepEqual(rows.map((x) => x.group).sort(), ["model_error", "test_gap"]);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("background run: collect sets worker timing from the job, keeps companion file list separately", () => {
  const s = stage();
  const repo = makeRepo();
  try {
    const r = s.cli("run", "--role", "luna-implement", "--packet", packet, "--cwd", repo, "--background");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    let [run] = s.runs();
    assert.equal(run.status, "submitted_background");
    assert.equal(run.duration_ms, null, "submission time is not worker runtime");
    assert.ok(run.submission_ms >= 0);
    const warn = s.cli("assess", run.run_id, "--outcome", "accepted");
    assert.match(warn.stdout, /ASSESS WARNING: run is still 'submitted_background'/);
    const c = s.cli("collect", run.run_id);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    [run] = s.runs();
    assert.equal(run.status, "completed");
    assert.ok(run.collected_at);
    assert.ok(Math.abs(run.worker_duration_ms - 60000) < 5000);
    assert.equal(run.touched_files_source, "git");
    assert.deepEqual(run.touched_files_reported, ["reported-by-companion.js"]);
    assert.equal(run.worker_patch.lines_added, 2);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("assess validates new flags; abandon closes orphans and frees the budget", () => {
  const s = stage();
  const repo = makeRepo();
  try {
    s.cli("run", "--role", "luna-implement", "--packet", packet, "--cwd", repo, "--max-attempts", "1");
    const [run] = s.runs();
    assert.equal(s.cli("assess", run.run_id, "--outcome", "accepted", "--cause", "bogus").status, 2);
    assert.equal(s.cli("assess", run.run_id, "--outcome", "accepted", "--verified", "none,tests").status, 2);
    assert.equal(s.cli("assess", run.run_id, "--outcome", "accepted", "--findings", "2", "--verified-findings", "3").status, 2);
    assert.equal(s.cli("abandon", run.run_id).status, 2, "completed runs cannot be abandoned");

    // Simulate a foreground wrapper killed mid-run.
    const file = path.join(s.dir, "runs", `${run.run_id}.run.json`);
    fs.writeFileSync(file, JSON.stringify({ ...run, status: "running" }));
    assert.equal(s.cli("run", "--role", "luna-implement", "--packet", packet, "--cwd", repo, "--max-attempts", "1").status, 4);
    assert.match(s.cli("runs").stdout, /1 run\(s\) not finalized/);
    const ab = s.cli("abandon", run.run_id, "--reason", "wrapper killed by shell timeout");
    assert.equal(ab.status, 0, ab.stdout + ab.stderr);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).status, "abandoned");
    assert.equal(s.cli("run", "--role", "luna-implement", "--packet", packet, "--cwd", repo, "--max-attempts", "1").status, 0);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("metrics --runs-dir reads schema-1 records from an extracted pack", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-pack-"));
  try {
    const host = path.join(dir, "HOST-win32-user", "runs");
    fs.mkdirSync(path.join(host, "_validation"), { recursive: true });
    const old = { schema_version: 1, run_id: "r1", role: "luna-implement", cwd: "C:\\x\\proj", status: "completed",
      duration_ms: 600000, started_at: "2026-10-10T00:00:00Z", assessment: { outcome: "accepted" } };
    fs.writeFileSync(path.join(host, "r1.run.json"), JSON.stringify(old));
    fs.writeFileSync(path.join(dir, "dup.run.json"), JSON.stringify(old));
    fs.writeFileSync(path.join(host, "_validation", "v.run.json"), JSON.stringify({ ...old, run_id: "v" }));
    const s = stage();
    try {
      const r = s.cli("metrics", "--runs-dir", dir, "--by", "project", "--json");
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout).map((x) => [x.group, x.runs, x.accepted]), [["proj", 1, 1]]);
      const all = JSON.parse(s.cli("metrics", "--runs-dir", dir, "--all", "--json").stdout);
      assert.equal(all.runs_total, 2);
    } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
