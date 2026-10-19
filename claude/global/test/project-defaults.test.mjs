// End-to-end tests for optional per-project packet defaults using only a local Codex stub.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const REPORT = "status: completed\nsummary: stub result\nfiles_changed: []\nchecks_run: []\nunresolved_issues: []\nrisks: []\nfollow_up: []\n";
const STUB = `
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) process.exit(0);
const input = await new Promise((resolve) => { let text = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", x => text += x); process.stdin.on("end", () => resolve(text)); });
fs.writeFileSync(path.join(args[args.indexOf("-C") + 1], "exec-capture.json"), JSON.stringify({ args, input }));
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "project-stub" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: {} }) + "\\n");
fs.writeFileSync(args[args.indexOf("-o") + 1], ${JSON.stringify(REPORT)});
`;

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-defaults-test-"));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(path.join(dir, "repo-wt"), { recursive: true, force: true }); });
  const kit = path.join(dir, "kit"); fs.mkdirSync(kit);
  for (const [source, target] of [["shared", "shared"], ["codex", "codex"], ["claude/global/scripts", "scripts"], ["claude/global/config", "config"]])
    fs.cpSync(path.join(REPO, source), path.join(kit, target), { recursive: true });
  fs.rmSync(path.join(kit, "config", "models.local.json"), { force: true });
  const repo = path.join(dir, "repo"); fs.mkdirSync(repo);
  git(repo, "init", "-q"); git(repo, "config", "user.email", "test@example.test"); git(repo, "config", "user.name", "test");
  const subdir = path.join(repo, "src", "nested"); fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n"); fs.writeFileSync(path.join(subdir, "keep.txt"), "tracked cwd\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const packet = path.join(dir, "packet.yaml");
  fs.writeFileSync(packet, "id: project-test\nobjective: exercise project defaults\neditable_paths: []\nconstraints:\n  - original constraint\nrequired_checks:\n  - original check\nacceptance_criteria: []\n");
  const reviewPacket = path.join(dir, "review.yaml");
  fs.writeFileSync(reviewPacket, "id: review-test\nrequirements: inspect behavior\nartifact: wrapper\nrationale: hidden rationale\n");
  const stub = path.join(dir, "stub-codex.mjs"); fs.writeFileSync(stub, STUB);
  const home = path.join(dir, "empty-home"); fs.mkdirSync(home);
  const quota = path.join(dir, "quota.json"); fs.writeFileSync(quota, JSON.stringify({ usedPercent: 0, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }));
  const env = { ...process.env, CODEX_BIN: stub, CODEX_QUOTA_SNAPSHOT: quota, APPDATA: home, HOME: home, USERPROFILE: home, CODEX_HOME: home };
  delete env.ORCH_BACKEND; delete env.CODEX_COMPANION;
  const wrapper = path.join(kit, "scripts", "codex-delegate.mjs");
  const cli = (args) => spawnSync(process.execPath, [wrapper, ...args], { encoding: "utf8", env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const runs = () => fs.readdirSync(path.join(kit, "runs")).filter(n => n.endsWith(".run.json"))
    .map(n => JSON.parse(fs.readFileSync(path.join(kit, "runs", n), "utf8")));
  return { dir, kit, repo, subdir, packet, reviewPacket, home, quota, wrapper, env, cli, runs };
}

function writeProject(f, config, location = f.repo) {
  const dir = path.join(location, ".orchestration"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "project.json"); fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n"); return file;
}

function runArgs(f, role = "luna-implement", cwd = f.subdir, packet = f.packet, ...extra) {
  return ["run", "--role", role, "--packet", packet, "--cwd", cwd, ...extra];
}

test("project defaults append from repo root cwd discovery and record exact prompt metadata", (t) => {
  const f = fixture(t);
  const originalPacket = fs.readFileSync(f.packet, "utf8");
  const projectFile = writeProject(f, { schema_version: 1, constraints: ["project: keep safe", "line\nnext"], required_checks: ["node --test"], context: "Project context line", roles: { "luna-implement": { model: "project-model", effort: "medium" } } });
  const result = f.cli(runArgs(f, "luna-implement", f.subdir, f.packet, "--worktree"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PROJECT: .*\(\+2 constraints, \+1 checks, context yes, overrides: model, effort\)/);
  const [run] = f.runs();
  assert.ok(run.worktree, "project config is discovered before switching to the worktree");
  const sent = JSON.parse(fs.readFileSync(path.join(run.worktree.path, "src", "nested", "exec-capture.json"), "utf8"));
  assert.ok(sent.input.includes("  - original constraint\n  - \"project: keep safe\"\n  - \"line\\nnext\""));
  assert.ok(sent.input.includes("  - original check\n  - \"node --test\""));
  assert.ok(sent.input.includes("project_context: |\n  Project context line"));
  assert.equal(run.required_checks_count, 2);
  assert.equal(run.model, "project-model"); assert.equal(run.model_source, "project");
  assert.equal(run.effort, "medium"); assert.equal(run.effort_source, "project");
  assert.deepEqual(run.project_config.applied, { constraints: 2, required_checks: 1, context: true, model: true, effort: true });
  assert.equal(run.project_config.file, projectFile);
  assert.match(run.prompt_sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(f.packet, "utf8"), originalPacket);

  const cliOverride = f.cli(runArgs(f, "luna-implement", f.subdir, f.packet, "--effort", "low", "--dry-run"));
  assert.equal(cliOverride.status, 0, cliOverride.stdout + cliOverride.stderr);
  const second = f.runs().find(r => r.effort_source === "cli");
  assert.match(cliOverride.stdout, /-m project-model -c model_reasoning_effort=low/);
  assert.equal(second.effort, "low"); assert.equal(second.effort_source, "cli");
});

test("no project file remains byte stable and discovery respects repository boundaries", (t) => {
  const f = fixture(t);
  const noProject = f.cli(runArgs(f, "luna-implement", f.subdir, f.packet, "--dry-run")); assert.equal(noProject.status, 0, noProject.stdout + noProject.stderr);
  const baseline = f.runs()[0];
  assert.equal(baseline.project_config, null);
  assert.equal(baseline.prompt_sha256, crypto.createHash("sha256").update(fs.readFileSync(baseline.prompt_file)).digest("hex"));
  const parentProject = writeProject(f, { schema_version: 1, constraints: ["outside root"] }, path.dirname(f.repo));
  const outside = path.join(f.dir, "outside"); fs.mkdirSync(outside);
  const outsideProject = writeProject(f, { schema_version: 1, context: "outside repo context" }, outside);
  const nestedRepo = f.cli(runArgs(f, "luna-implement", f.subdir, f.packet, "--dry-run")); assert.equal(nestedRepo.status, 0, nestedRepo.stdout + nestedRepo.stderr);
  assert.equal(f.runs().find(r => r.task_id === "project-test" && r.run_id !== baseline.run_id).project_config, null);
  const outsideRun = f.cli(runArgs(f, "luna-implement", outside, f.packet, "--dry-run")); assert.equal(outsideRun.status, 0, outsideRun.stdout + outsideRun.stderr);
  assert.equal(f.runs().find(r => r.project_config?.file === outsideProject).project_config.file, outsideProject);
  assert.ok(fs.existsSync(parentProject));
});

test("Astra receives context only when review_safe, with static blind-review stripping intact", (t) => {
  const f = fixture(t);
  const args = ["run", "--role", "astra-review", "--packet", f.reviewPacket, "--cwd", f.repo];
  writeProject(f, { schema_version: 1, constraints: ["secret constraint"], required_checks: ["secret check"], context: "safe context", review_safe: false });
  const unsafe = f.cli([...args, "--dry-run"]); assert.equal(unsafe.status, 0, unsafe.stdout + unsafe.stderr);
  let run = f.runs().at(-1);
  let sent = { input: fs.readFileSync(run.prompt_file, "utf8") };
  assert.equal(run.project_config.applied.context, false);
  assert.ok(!sent.input.includes("safe context")); assert.ok(!sent.input.includes("hidden rationale"));
  writeProject(f, { schema_version: 1, constraints: ["secret constraint"], required_checks: ["secret check"], context: "safe context", review_safe: true });
  const safe = f.cli([...args, "--dry-run"]); assert.equal(safe.status, 0, safe.stdout + safe.stderr);
  run = f.runs().at(-1); sent = { input: fs.readFileSync(run.prompt_file, "utf8") };
  assert.equal(run.project_config.applied.constraints, 0); assert.equal(run.project_config.applied.required_checks, 0);
  assert.equal(run.project_config.applied.context, true);
  assert.ok(sent.input.includes("safe context")); assert.ok(!sent.input.includes("secret constraint"));
  assert.ok(!sent.input.includes("secret check")); assert.ok(!sent.input.includes("hidden rationale"));
});

test("missing list keys are created, flow lists fail clearly, and invalid configs name their file", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.packet, "id: no-lists\nobjective: no list blocks\neditable_paths: []\nacceptance_criteria: []\n");
  writeProject(f, { schema_version: 1, constraints: ["new constraint"], required_checks: ["new check"] });
  const created = f.cli(runArgs(f, "luna-implement", f.subdir, f.packet, "--dry-run")); assert.equal(created.status, 0, created.stdout + created.stderr);
  let sent = { input: fs.readFileSync(f.runs().at(-1).prompt_file, "utf8") };
  assert.ok(sent.input.includes("constraints:\n  - \"new constraint\""));
  assert.ok(sent.input.includes("required_checks:\n  - \"new check\""));
  fs.writeFileSync(f.packet, "id: flow\nobjective: flow list\neditable_paths: []\nconstraints: []\nacceptance_criteria: []\n");
  const flow = f.cli(runArgs(f)); assert.equal(flow.status, 2); assert.match(flow.stderr, /packet constraints must be a block list to receive project defaults/);

  const file = path.join(f.repo, ".orchestration", "project.json");
  for (const raw of ["{bad", JSON.stringify({ schema_version: 1, extra: true }), JSON.stringify({ schema_version: 1, roles: { madeup: {} } }), JSON.stringify({ schema_version: 1, roles: { "luna-test": { effort: "turbo" } } }), JSON.stringify({ schema_version: 2 })]) {
    fs.writeFileSync(file, raw);
    const invalid = f.cli(["config", "--explain", "luna-implement", "--cwd", f.repo]);
    assert.equal(invalid.status, 2); assert.ok(invalid.stderr.includes(file));
  }
});

test("config explain reports effective settings and validates role", (t) => {
  const f = fixture(t);
  writeProject(f, { schema_version: 1, constraints: ["one"], required_checks: ["check"], context: "context", review_safe: true,
    roles: { "luna-implement": { model: "explained-model", effort: "medium" } } });
  const explained = f.cli(["config", "--explain", "luna-implement", "--cwd", f.subdir, "--json"]);
  assert.equal(explained.status, 0, explained.stdout + explained.stderr);
  const data = JSON.parse(explained.stdout);
  assert.equal(data.model, "explained-model"); assert.equal(data.model_source, "project");
  assert.equal(data.effort, "medium"); assert.equal(data.effort_source, "project");
  assert.deepEqual(data.constraints, ["one"]); assert.deepEqual(data.required_checks, ["check"]);
  assert.equal(data.context, "context");
  const unknown = f.cli(["config", "--explain", "unknown-role", "--cwd", f.repo]);
  assert.equal(unknown.status, 2);
});

test("column-0 and multi-line list items keep the packet's own indentation", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.packet, [
    "id: col0", "objective: column zero lists", "editable_paths: []", "acceptance_criteria: []",
    "constraints:", "- existing constraint", "- >-", "  folded constraint", "  continues here",
    "required_checks:", "  # comment line", "  - node --test", ""
  ].join("\n"));
  writeProject(f, { schema_version: 1, constraints: ["project constraint"], required_checks: ["npm run lint"] });
  const result = f.cli(runArgs(f, "luna-implement", f.subdir, f.packet, "--dry-run"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const run = f.runs().find((r) => r.task_id === "col0");
  const prompt = fs.readFileSync(run.prompt_file, "utf8");
  assert.ok(prompt.includes("  continues here\n- \"project constraint\""), "appended at column 0 after the folded item");
  assert.ok(prompt.includes("  - node --test\n  - \"npm run lint\""), "appended with two-space indent");
  assert.equal(run.required_checks_count, 2);
});
