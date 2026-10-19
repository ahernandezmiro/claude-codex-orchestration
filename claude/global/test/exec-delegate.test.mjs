// End-to-end tests for codex-delegate's detached exec backend. All workers are local stubs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const REPORT = "status: completed\nsummary: stub result\nfiles_changed: []\nchecks_run:\n  - command: node test.mjs\n    result: pass\nunresolved_issues: []\nrisks: []\nfollow_up: []\n";
const STUB = `
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("stub codex 1"); process.exit(0); }
const input = await new Promise((resolve) => { let text = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", x => text += x); process.stdin.on("end", () => resolve(text)); });
const last = args[args.indexOf("-o") + 1];
fs.writeFileSync(path.join(args[args.indexOf("-C") + 1], "exec-capture.json"), JSON.stringify({ args, input }));
if (process.env.EXEC_STUB_MODE === "sleep") await new Promise(resolve => setTimeout(resolve, 60000));
if (args[args.indexOf("-s") + 1] === "workspace-write") fs.writeFileSync(path.join(args[args.indexOf("-C") + 1], "worker.txt"), "worker output\\n");
if (process.env.EXEC_STUB_MODE === "quota" || process.env.EXEC_STUB_MODE === "turn-failed") {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-stub" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: process.env.EXEC_STUB_MODE === "quota" ? "You've hit your usage limit" : "stub turn failed" } }) + "\\n");
  process.exit(process.env.EXEC_STUB_MODE === "quota" ? 1 : 0);
}
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-stub" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 21, cached_input_tokens: 6, output_tokens: 8, reasoning_output_tokens: 2 } }) + "\\n");
fs.writeFileSync(last, ${JSON.stringify(REPORT)});
`;

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-delegate-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kit = path.join(dir, "kit"); fs.mkdirSync(kit);
  for (const [source, target] of [["shared", "shared"], ["codex", "codex"], ["claude/global/scripts", "scripts"], ["claude/global/config", "config"]])
    fs.cpSync(path.join(REPO, source), path.join(kit, target), { recursive: true });
  fs.rmSync(path.join(kit, "config", "models.local.json"), { force: true });
  const repo = path.join(dir, "repo"); fs.mkdirSync(repo);
  git(repo, "init", "-q"); git(repo, "config", "user.email", "test@example.test"); git(repo, "config", "user.name", "test");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const packet = path.join(dir, "packet.yaml");
  fs.writeFileSync(packet, "id: exec-test\nobjective: exercise exec backend\neditable_paths: []\nacceptance_criteria: []\nrequired_checks:\n  - command: node test.mjs\n");
  const reviewPacket = path.join(dir, "review-packet.yaml");
  fs.writeFileSync(reviewPacket, "id: exec-review\nrequirements: inspect behavior\nartifact: wrapper\n");
  const stub = path.join(dir, "stub-codex.mjs"); fs.writeFileSync(stub, STUB);
  const companion = path.join(dir, "stub-companion.mjs");
  fs.writeFileSync(companion, `import fs from "node:fs"; const a=process.argv.slice(2); if(a.includes("--version")) process.exit(0); const i=a.indexOf("--prompt-file"); const prompt=fs.readFileSync(a[i+1],"utf8"); if(a.includes("--background")) console.log("Submitted task-abc123-xyz9"); else console.log(prompt); process.exit(0);`);
  const emptyHome = path.join(dir, "empty-home"); fs.mkdirSync(emptyHome);
  const quota = path.join(dir, "quota.json"); fs.writeFileSync(quota, JSON.stringify({ usedPercent: 0, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }));
  const capture = path.join(repo, "exec-capture.json");
  const wrapper = path.join(kit, "scripts", "codex-delegate.mjs");
  const env = { ...process.env, CODEX_BIN: stub, CODEX_QUOTA_SNAPSHOT: quota,
    APPDATA: emptyHome, HOME: emptyHome, USERPROFILE: emptyHome, CODEX_HOME: emptyHome };
  delete env.ORCH_BACKEND; delete env.CODEX_COMPANION;
  const cli = (args, extra = {}) => spawnSync(process.execPath, [wrapper, ...args], {
    encoding: "utf8", env: { ...env, ...extra }, timeout: 30000, maxBuffer: 4 * 1024 * 1024
  });
  const runs = () => fs.readdirSync(path.join(kit, "runs")).filter(name => name.endsWith(".run.json"))
    .map(name => JSON.parse(fs.readFileSync(path.join(kit, "runs", name), "utf8")));
  return { dir, kit, repo, packet, reviewPacket, stub, companion, emptyHome, quota, capture, wrapper, env, cli, runs };
}

function runArgs(f, role = "luna-implement", ...extra) {
  return ["run", "--role", role, "--packet", f.packet, "--cwd", f.repo, ...extra];
}

test("foreground defaults to exec, passes exact prompt and role arguments, records output and Git attribution", (t) => {
  const f = fixture(t);
  const result = f.cli(runArgs(f));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [run] = f.runs();
  const sent = JSON.parse(fs.readFileSync(path.join(run.cwd, "exec-capture.json"), "utf8"));
  assert.equal(run.backend, "exec");
  assert.equal(run.job_id, `exec:${run.run_id}`);
  assert.equal(sent.input, fs.readFileSync(run.prompt_file, "utf8"));
  assert.ok(sent.args.includes("-s") && sent.args.includes("workspace-write"));
  assert.ok(sent.args.includes("-m") && sent.args.includes("gpt-6-luna"));
  assert.ok(sent.args.includes("model_reasoning_effort=high"));
  assert.ok(sent.args.includes("approval_policy=never"));
  assert.ok(sent.args.includes(f.repo));
  assert.equal(fs.readFileSync(run.stdout_file, "utf8"), REPORT);
  assert.equal(run.worker_report.status, "completed");
  assert.equal(run.codex_usage.input_tokens, 21);
  assert.ok(run.touched_files.includes(path.join(f.repo, "worker.txt")));
  assert.ok(run.worker_patch.lines_added > 0);
  assert.ok(run.collected_at);
});

test("read-only roles use read-only sandbox; quota turn failure and exit-zero turn failure stay failed", (t) => {
  const f = fixture(t);
  const review = f.cli(["run", "--role", "astra-review", "--packet", f.reviewPacket, "--cwd", f.repo]);
  assert.equal(review.status, 0, review.stdout + review.stderr);
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.repo, "exec-capture.json"), "utf8")).args.includes("read-only"));
  for (const [mode, hint, code] of [["quota", "quota", 1], ["turn-failed", "turn_failed", 1]]) {
    const result = f.cli(runArgs(f), { EXEC_STUB_MODE: mode });
    assert.equal(result.status, code, result.stdout + result.stderr);
    const run = f.runs().at(-1);
    assert.equal(run.status, "failed");
    assert.equal(run.failure_hint, hint);
  }
});

test("background exec collect finalizes once and preserves the worker snapshot", (t) => {
  const f = fixture(t);
  const launched = f.cli(runArgs(f, "luna-implement", "--background"));
  assert.equal(launched.status, 0, launched.stdout + launched.stderr);
  const run = f.runs()[0];
  assert.equal(run.status, "submitted_background");
  const collected = f.cli(["collect", run.run_id, "--wait"]);
  assert.equal(collected.status, 0, collected.stdout + collected.stderr);
  const first = f.runs()[0];
  assert.equal(first.status, "completed"); assert.ok(first.worker_duration_ms); assert.equal(first.codex_usage.output_tokens, 8);
  fs.writeFileSync(path.join(f.repo, "worker.txt"), "later edit\n");
  const immutable = [first.worker_tree, first.worker_patch, first.touched_files, first.finished_at, first.collected_at, first.duration_ms, first.worker_duration_ms];
  const again = f.cli(["collect", run.run_id]);
  assert.equal(again.status, 0); assert.match(again.stdout, /already finalized \(completed\)/);
  const second = f.runs()[0];
  assert.deepEqual([second.worker_tree, second.worker_patch, second.touched_files, second.finished_at, second.collected_at, second.duration_ms, second.worker_duration_ms], immutable);
  const assessed = f.cli(["assess", run.run_id, "--outcome", "accepted"]);
  assert.equal(assessed.status, 0, assessed.stdout + assessed.stderr);
  const measured = f.cli(["show", run.run_id, "--json"]);
  assert.equal(measured.status, 0);
  const shown = JSON.parse(measured.stdout);
  assert.equal(shown.backend, "exec");
  assert.equal(shown.codex_usage.input_tokens, 21);
  assert.ok(shown.post_worker?.lines_added > 0);
  const metrics = f.cli(["metrics", "--json", "--runs-dir", path.join(f.kit, "runs")]);
  assert.equal(metrics.status, 0, metrics.stdout + metrics.stderr);
  assert.equal(JSON.parse(metrics.stdout).codex_usage.output_tokens, 8);
});

test("collect finalizes killed foreground records, respects locks, and reconciles stale pending runners", async (t) => {
  const f = fixture(t);
  const foreground = f.cli(runArgs(f, "luna-implement", "--background"));
  assert.equal(foreground.status, 0, foreground.stdout + foreground.stderr);
  const foregroundRun = f.runs()[0];
  const foregroundState = path.join(foregroundRun.exec.job_dir, "state.json");
  const deadline = Date.now() + 10000;
  while (!(["completed", "failed", "cancelled"].includes(JSON.parse(fs.readFileSync(foregroundState, "utf8")).status)) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 50));
  const simulatedKilledWrapper = { ...foregroundRun, background: false, status: "running", collected_at: null, git_guard: null };
  fs.writeFileSync(foregroundRun.run_file, JSON.stringify(simulatedKilledWrapper));
  const recoveredForeground = f.cli(["collect", foregroundRun.run_id]);
  assert.equal(recoveredForeground.status, 0, recoveredForeground.stdout + recoveredForeground.stderr);
  assert.match(recoveredForeground.stdout, /summary: stub result/);
  assert.equal(f.runs().find(item => item.run_id === foregroundRun.run_id).status, "completed");

  fs.writeFileSync(f.packet, "id: exec-test-lock\nobjective: exercise locks\neditable_paths: []\nacceptance_criteria: []\n");
  const launched = f.cli(runArgs(f, "luna-implement", "--background"));
  assert.equal(launched.status, 0, launched.stdout + launched.stderr);
  const run = f.runs().find(item => item.task_id === "exec-test-lock");
  const runFile = run.run_file;
  const lock = `${runFile}.lock`;
  fs.writeFileSync(lock, "held");
  const blocked = f.cli(["collect", run.run_id]);
  assert.equal(blocked.status, 2); assert.match(blocked.stdout, /another process is finalizing/);
  fs.utimesSync(lock, new Date(Date.now() - 11 * 60 * 1000), new Date(Date.now() - 11 * 60 * 1000));
  const resumed = f.cli(["collect", run.run_id, "--wait"]);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);

  const pending = f.runs().find(item => item.run_id === run.run_id);
  pending.status = "running"; pending.background = false; pending.collected_at = null;
  const statePath = path.join(pending.exec.job_dir, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.status = "pending"; state.runner_pid = null; state.submitted_at = new Date(Date.now() - 120000).toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state)); fs.writeFileSync(pending.run_file, JSON.stringify(pending));
  const recovered = f.cli(["collect", pending.run_id]);
  assert.equal(recovered.status, 1, recovered.stdout + recovered.stderr);
  const failed = f.runs().find(item => item.run_id === run.run_id);
  assert.equal(failed.status, "failed"); assert.equal(failed.failure_hint, "tool_error");
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).io_error, "runner never started");
});

test("cancel, missing Codex, companion override, which and dry-run behavior", (t) => {
  const f = fixture(t);
  const launched = f.cli(runArgs(f, "luna-implement", "--background"), { EXEC_STUB_MODE: "sleep" });
  assert.equal(launched.status, 0, launched.stdout + launched.stderr);
  const run = f.runs()[0];
  const cancelled = f.cli(["cancel", `exec:${run.run_id}`]);
  assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr); assert.match(cancelled.stdout, /CANCELLED/);
  assert.equal(f.runs()[0].status, "cancelled");
  const cancelledState = JSON.parse(fs.readFileSync(path.join(run.exec.job_dir, "state.json"), "utf8"));
  assert.equal(pidAlive(cancelledState.child_pid), false, "cancel stops the Codex stub process");
  const twice = f.cli(["cancel", run.run_id]);
  assert.equal(twice.status, 2); assert.match(twice.stdout, /already cancelled/);

  const absent = f.cli(runArgs(f), { CODEX_BIN: path.join(f.dir, "missing-codex") });
  assert.equal(absent.status, 2); assert.match(absent.stderr, /codex CLI missing/);
  const companion = f.cli(runArgs(f, "luna-implement", "--backend", "companion"), { CODEX_COMPANION: f.companion });
  assert.equal(companion.status, 0, companion.stdout + companion.stderr);
  const invalid = f.cli(runArgs(f, "luna-implement", "--backend", "bogus"));
  assert.equal(invalid.status, 2); assert.match(invalid.stderr, /exec or companion/);
  const which = f.cli(["which"]);
  assert.equal(which.status, 0, which.stdout + which.stderr); assert.match(which.stdout, /companion: not found/);
  const jobsBeforeDryRun = fs.readdirSync(path.join(f.kit, "runs")).filter(name => name.endsWith(".job")).length;
  const dry = f.cli(runArgs(f, "luna-implement", "--dry-run"));
  assert.equal(dry.status, 0, dry.stdout + dry.stderr); assert.match(dry.stdout, /DRY RUN: codex exec --json/);
  assert.equal(fs.readdirSync(path.join(f.kit, "runs")).filter(name => name.endsWith(".job")).length, jobsBeforeDryRun);
});

test("worktree exec points Codex into the worktree and leaves the main checkout unchanged", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.repo, "base.txt"), "utf8");
  const result = f.cli(runArgs(f, "luna-implement", "--worktree"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const run = f.runs()[0];
  const args = JSON.parse(fs.readFileSync(path.join(run.worktree.path, "exec-capture.json"), "utf8")).args;
  assert.equal(args[args.indexOf("-C") + 1], run.worktree.path);
  assert.equal(fs.readFileSync(path.join(f.repo, "base.txt"), "utf8"), before);
});

test("install preflight permits a missing companion when Codex CLI is available", (t) => {
  const f = fixture(t);
  const codex = path.join(f.dir, "preflight-codex.mjs");
  fs.writeFileSync(codex, `if (process.argv.includes("--version")) { console.log("codex 1"); process.exit(0); } if (process.argv[2] === "login" && process.argv[3] === "status") { console.log("Logged in"); process.exit(0); } if (process.argv[2] === "mcp-server") { console.log("Usage: codex mcp-server"); process.exit(0); } process.exit(0);`);
  const cache = path.join(f.emptyHome, ".codex"); fs.mkdirSync(cache);
  fs.writeFileSync(path.join(cache, "models_cache.json"), JSON.stringify({ models: ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"].map(slug => ({ slug })) }));
  const result = spawnSync(process.execPath, [path.join(REPO, "claude", "global", "install.mjs"), "--check"], {
    encoding: "utf8", env: { ...f.env, CODEX_BIN: codex }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /companion not installed \(only needed for --backend companion\)/);
});

test("finalize lock follows its owner pid: live owner blocks, dead owner is reclaimed", (t) => {
  const f = fixture(t);
  const launched = f.cli(runArgs(f, "luna-implement", "--background"));
  assert.equal(launched.status, 0, launched.stdout + launched.stderr);
  const [run] = f.runs();
  const lock = path.join(f.kit, "runs", `${run.run_id}.run.json.lock`);

  // The test process itself is a live owner, however old the lock file looks.
  fs.writeFileSync(lock, `${process.pid}\n`);
  fs.utimesSync(lock, new Date(Date.now() - 60 * 60 * 1000), new Date(Date.now() - 60 * 60 * 1000));
  const blocked = f.cli(["collect", run.run_id, "--wait"]);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stdout, /another process is finalizing/);

  // A pid that has already exited is a dead owner, even when the lock is fresh.
  const gone = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
  fs.writeFileSync(lock, `${gone}\n`);
  const reclaimed = f.cli(["collect", run.run_id, "--wait"]);
  assert.equal(reclaimed.status, 0, reclaimed.stdout + reclaimed.stderr);
  assert.equal(f.runs()[0].status, "completed");
  assert.equal(fs.existsSync(lock), false, "lock released after finalizing");
});
