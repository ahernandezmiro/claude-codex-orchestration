// Stub-driven tests for the standalone codex exec backend and detached job runner.
// No test invokes the real Codex CLI; all job data lives in os.tmpdir().

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildExecArgs, cancelJob, normalizeExecResult, readJob, reconcileLost, resolveCodexBin,
  submitJob, summarizeEvents, waitJob
} from "../scripts/exec-backend.mjs";

const STUB = `
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const input = await new Promise((resolve) => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (x) => s += x); process.stdin.on("end", () => resolve(s)); });
if (process.env.EXPECT_ARGS && JSON.stringify(args) !== process.env.EXPECT_ARGS) process.exit(91);
if (process.env.INPUT_FILE) fs.writeFileSync(process.env.INPUT_FILE, input);
if (process.env.STUB_MODE === "version") { console.log("codex stub 1"); process.exit(0); }
if (process.env.STUB_MODE === "fail-version") process.exit(1);
if (process.env.STUB_MODE === "sleep" || process.env.STUB_MODE === "grandchild") {
  if (process.env.STUB_MODE === "grandchild") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(process.env.GRANDCHILD_PID_FILE, String(child.pid));
  }
  await new Promise((resolve) => setTimeout(resolve, 60000));
}
if (process.env.STUB_MODE === "large") {
  for (let i = 0; i < 65000; i++) process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "i" + i, type: "command_execution", exit_code: 0, text: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" } }) + "\\n");
  fs.writeFileSync(opt("-o"), "large done");
  process.exit(0);
}
if (process.env.STUB_MODE === "no-events") process.exit(1);
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-test" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "cmd", type: "command_execution", exit_code: 0 } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 3, reasoning_output_tokens: 1 } }) + "\\n");
fs.writeFileSync(opt("-o"), "stub final message");
`;

function temp(prefix = "exec-backend-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function stateOf(jobDir) {
  return JSON.parse(fs.readFileSync(path.join(jobDir, "state.json"), "utf8"));
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function makeFixture(t, mode = "happy", extraEnv = {}) {
  const tmp = temp();
  t.after(tmp.clean);
  const stub = path.join(tmp.dir, "stub-codex.mjs");
  const promptFile = path.join(tmp.dir, "prompt.txt");
  const jobDir = path.join(tmp.dir, "job");
  fs.writeFileSync(stub, STUB);
  fs.writeFileSync(promptFile, "prompt bytes\nline two\0tail");
  const env = { ...process.env, STUB_MODE: mode, ...extraEnv };
  const args = ["exec", "--json", "-s", "read-only", "-o", path.join(jobDir, "last-message.txt"), "-"];
  return { tmp, stub, promptFile, jobDir, env, args };
}

async function start(f, overrides = {}) {
  const previous = new Map();
  for (const [key, value] of Object.entries(f.env)) {
    if (key in process.env) previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await submitJob({ jobDir: f.jobDir, command: process.execPath, prefixArgs: [f.stub], args: f.args,
      cwd: f.tmp.dir, promptFile: f.promptFile, ...overrides });
  } finally {
    for (const key of Object.keys(f.env)) {
      if (previous.has(key)) process.env[key] = previous.get(key);
      else delete process.env[key];
    }
  }
}

async function submitWithEnv(f, options) {
  const previous = new Map();
  for (const [key, value] of Object.entries(f.env)) {
    if (key in process.env) previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try { return await submitJob(options); }
  finally {
    for (const key of Object.keys(f.env)) {
      if (previous.has(key)) process.env[key] = previous.get(key);
      else delete process.env[key];
    }
  }
}

test("buildExecArgs returns the documented vector and rejects unsafe sandboxes", () => {
  const common = { cwd: "/work/tree", model: "gpt-6-luna", effort: "low", lastMessageFile: "/job/last.txt" };
  assert.deepEqual(buildExecArgs({ ...common, sandbox: "read-only" }), ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "-m", "gpt-6-luna", "-c", "model_reasoning_effort=low", "-c", "approval_policy=never", "-C", "/work/tree", "-o", "/job/last.txt", "-"]);
  assert.deepEqual(buildExecArgs({ ...common, sandbox: "workspace-write" })[4], "workspace-write");
  assert.throws(() => buildExecArgs({ ...common, sandbox: "danger-full-access" }), /unsupported sandbox/);
});

test("resolveCodexBin handles JS overrides, missing and broken executables, and Windows shims", (t) => {
  const tmp = temp();
  t.after(tmp.clean);
  const good = path.join(tmp.dir, "good.mjs");
  const broken = path.join(tmp.dir, "broken.mjs");
  fs.writeFileSync(good, "if (process.argv.includes('--version')) process.exit(0);\n");
  fs.writeFileSync(broken, "process.exit(1);\n");
  const js = resolveCodexBin({ env: { ...process.env, CODEX_BIN: good } });
  assert.deepEqual(js, { ok: true, command: process.execPath, prefixArgs: [good], source: "CODEX_BIN" });
  assert.equal(resolveCodexBin({ env: { ...process.env, CODEX_BIN: path.join(tmp.dir, "missing") } }).reason, "missing");
  assert.equal(resolveCodexBin({ env: { ...process.env, CODEX_BIN: broken } }).reason, "broken");
  fs.writeFileSync(path.join(tmp.dir, "codex.cmd"), "@exit /b 0\n");
  assert.equal(resolveCodexBin({ env: { PATH: tmp.dir }, platform: "win32" }).reason, "unsupported_shim");
  assert.equal(resolveCodexBin({ env: { PATH: path.join(tmp.dir, "empty") }, platform: "win32" }).reason, "missing");
});

test("summarizeEvents sums usage and separates config warnings, malformed input and failures", () => {
  const lines = [
    { type: "thread.started", thread_id: "t1" },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 } },
    { type: "item.completed", item: { type: "error", message: "unrecognized configuration settings" } },
    { type: "turn.completed", usage: { input_tokens: 7, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 3 } },
    "not-json",
    { type: "turn.failed", error: { message: "failure one" } },
    { type: "error", message: "failure two" },
    { type: "item.completed", item: { type: "command_execution" } },
    { type: "item.completed", item: { type: "file_change" } }
  ].map((x) => typeof x === "string" ? x : JSON.stringify(x)).join("\n");
  assert.deepEqual(summarizeEvents(lines), { thread_id: "t1", turns_completed: 2,
    usage: { input_tokens: 17, cached_input_tokens: 6, output_tokens: 7, reasoning_output_tokens: 4 },
    failures: ["failure one", "failure two"], warnings: 1, malformed_lines: 1, commands: 1, file_changes: 1 });
});

test("normalizeExecResult applies all precedence rules and retains every matching reason", () => {
  const events = { failures: [], turns_completed: 1 };
  const cases = [
    [{ status: "cancelled", exit_code: 1, signal: "SIGTERM" }, { ...events, turns_completed: 0 }, false, "cancelled", null, ["cancelled", "killed", "exit_code", "no_turn_completed"]],
    [{ status: "failed", spawn_error: "ENOENT", io_error: "bad", exit_code: 1 }, { ...events, turns_completed: 0 }, false, "failed", "tool_error", ["tool_error", "exit_code", "no_turn_completed"]],
    [{ status: "lost", signal: "SIGKILL", exit_code: 1 }, { ...events, turns_completed: 0 }, false, "failed", "runner_lost", ["runner_lost", "killed", "exit_code", "no_turn_completed"]],
    [{ status: "failed", signal: "SIGTERM", exit_code: 1 }, { ...events, turns_completed: 0 }, false, "failed", "killed", ["killed", "exit_code", "no_turn_completed"]],
    [{ status: "failed", exit_code: 0 }, { failures: ["You've hit your usage limit"], turns_completed: 1 }, true, "failed", "quota", ["turn_failed"]],
    [{ status: "failed", exit_code: 2 }, events, true, "failed", "exit_code", ["exit_code"]],
    [{ status: "failed", exit_code: 0 }, { ...events, turns_completed: 0 }, true, "failed", "no_turn_completed", ["no_turn_completed"]],
    [{ status: "completed", exit_code: 0 }, events, false, "completed", null, ["no_final_message"]]
  ];
  for (const [state, ev, exists, status, hint, reasons] of cases) {
    const got = normalizeExecResult({ state, events: ev, finalMessageExists: exists });
    assert.equal(got.status, status);
    assert.equal(got.failure_hint, hint);
    assert.deepEqual(got.reasons, reasons);
  }
  const turnFailExit0 = normalizeExecResult({ state: { status: "failed", exit_code: 0 },
    events: { failures: ["turn failure"], turns_completed: 1 }, finalMessageExists: true });
  assert.equal(turnFailExit0.status, "failed");
  assert.equal(turnFailExit0.failure_hint, "turn_failed");
});

test("submitJob and waitJob preserve prompt bytes, args, events, final message and usage", async (t) => {
  const inputFile = path.join(os.tmpdir(), `exec-input-${process.pid}-${Date.now()}`);
  const f = makeFixture(t, "happy", { INPUT_FILE: inputFile });
  try {
    const submitted = await start(f);
    assert.equal(submitted.state.status, "running");
    const result = await waitJob(f.jobDir, { timeoutMs: 10000 });
    assert.equal(result.state.status, "completed");
    assert.equal(fs.readFileSync(inputFile, "utf8"), fs.readFileSync(f.promptFile, "utf8"));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.jobDir, "spec.json"), "utf8")).args, f.args);
    assert.ok(fs.readFileSync(path.join(f.jobDir, "events.jsonl"), "utf8").includes('"thread_id":"thread-test"'));
    assert.equal(fs.readFileSync(path.join(f.jobDir, "last-message.txt"), "utf8"), "stub final message");
    assert.equal(result.events.usage.input_tokens, 20);
    assert.equal(result.finalMessage, "stub final message");
  } finally { fs.rmSync(inputFile, { force: true }); }
});

test("large event output is flushed before runner completion", async (t) => {
  const f = makeFixture(t, "large");
  await start(f);
  const result = await waitJob(f.jobDir, { timeoutMs: 20000 });
  assert.equal(result.state.status, "completed");
  assert.ok(fs.statSync(path.join(f.jobDir, "events.jsonl")).size >= 5 * 1024 * 1024);
});

test("nonzero exit without events fails normalization", async (t) => {
  const f = makeFixture(t, "no-events");
  await start(f);
  const result = await waitJob(f.jobDir, { timeoutMs: 10000 });
  assert.equal(result.state.status, "failed");
  assert.equal(result.state.exit_code, 1);
  const normalized = normalizeExecResult({ state: result.state, events: result.events, finalMessageExists: false });
  assert.equal(normalized.status, "failed");
  assert.equal(normalized.failure_hint, "exit_code");
});

test("cancelJob kills runner, child and grandchild; repeat and completed cancellation do not alter state", async (t) => {
  const grandchildPidFile = path.join(os.tmpdir(), `exec-grandchild-${process.pid}-${Date.now()}`);
  const f = makeFixture(t, "grandchild", { GRANDCHILD_PID_FILE: grandchildPidFile });
  try {
    await start(f);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(grandchildPidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(grandchildPidFile), "stub spawned its grandchild");
    const initial = stateOf(f.jobDir);
    const grandchildPid = Number(fs.readFileSync(grandchildPidFile, "utf8"));
    const result = await cancelJob(f.jobDir, { graceMs: 200 });
    assert.equal(result.ok, true, JSON.stringify({ result, state: stateOf(f.jobDir), initial, grandchildPid }));
    assert.equal(result.status, "cancelled");
    const final = stateOf(f.jobDir);
    assert.equal(final.status, "cancelled");
    assert.equal(pidAlive(initial.runner_pid), false);
    assert.equal(pidAlive(initial.child_pid), false);
    assert.equal(pidAlive(grandchildPid), false);
    const second = await cancelJob(f.jobDir);
    assert.equal(second.ok, false);
    assert.deepEqual(stateOf(f.jobDir), final);
  } finally { fs.rmSync(grandchildPidFile, { force: true }); }

  const completed = makeFixture(t, "happy");
  await start(completed);
  await waitJob(completed.jobDir, { timeoutMs: 10000 });
  const before = stateOf(completed.jobDir);
  assert.deepEqual(await cancelJob(completed.jobDir), { ok: false, status: "completed" });
  assert.deepEqual(stateOf(completed.jobDir), before);
});

test("cancel immediately after submit prevents Codex from starting", async (t) => {
  const marker = path.join(os.tmpdir(), `exec-input-race-${process.pid}-${Date.now()}`);
  const f = makeFixture(t, "happy", { INPUT_FILE: marker });
  try {
    const submitted = await submitWithEnv(f, { jobDir: f.jobDir, command: process.execPath, prefixArgs: [f.stub], args: f.args,
      cwd: f.tmp.dir, promptFile: f.promptFile, startupTimeoutMs: 0 });
    assert.equal(submitted.state.status, "pending");
    const result = await cancelJob(f.jobDir, { graceMs: 20 });
    assert.equal(result.ok, true);
    assert.equal(stateOf(f.jobDir).status, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(marker, { force: true }); }
});

test("runner loss is detected and reconciliation stops the surviving child", async (t) => {
  const f = makeFixture(t, "sleep");
  await start(f);
  const running = stateOf(f.jobDir);
  assert.ok(running.child_pid);
  process.kill(running.runner_pid, "SIGKILL");
  const lost = readJob(f.jobDir);
  assert.equal(lost.state.status, "lost", JSON.stringify({ state: lost.state, running, alive: pidAlive(running.runner_pid) }));
  const failed = await reconcileLost(f.jobDir);
  assert.equal(failed.status, "failed");
  assert.equal(failed.io_error, "runner lost");
  assert.equal(pidAlive(running.child_pid), false);
});

test("spawn failure is recorded as a tool error", async (t) => {
  const f = makeFixture(t, "happy");
  await submitWithEnv(f, { jobDir: f.jobDir, command: path.join(f.tmp.dir, "absent"), prefixArgs: [], args: [],
    cwd: f.tmp.dir, promptFile: f.promptFile });
  const result = await waitJob(f.jobDir, { timeoutMs: 10000 });
  assert.equal(result.state.status, "failed");
  assert.match(result.state.spawn_error, /ENOENT|not found/i);
  assert.equal(normalizeExecResult({ state: result.state, events: result.events, finalMessageExists: false }).failure_hint, "tool_error");
});
