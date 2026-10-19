// Standalone `codex exec` backend. Owns executable resolution, job files, event summaries,
// result normalization, and cancellation/lost-runner recovery for codex-delegate.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { looksLikeQuotaStop } from "./telemetry-lib.mjs";

const RUNNER = fileURLToPath(new URL("./exec-runner.mjs", import.meta.url));
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function atomicJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readState(jobDir) {
  return JSON.parse(fs.readFileSync(path.join(jobDir, "state.json"), "utf8"));
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

function terminal(state) {
  return TERMINAL.has(state?.status);
}

/**
 * Resolve and verify a Codex executable without invoking a shell.
 * Input: optional environment and platform override. Output: executable descriptor or failure reason.
 */
export function resolveCodexBin({ env = process.env, platform = process.platform } = {}) {
  let command;
  let prefixArgs = [];
  let source;
  if (env.CODEX_BIN) {
    command = path.resolve(process.cwd(), env.CODEX_BIN);
    source = "CODEX_BIN";
    if (!fs.existsSync(command)) return { ok: false, reason: "missing", detail: `CODEX_BIN does not exist: ${command}` };
    if (/\.(?:mjs|js|cjs)$/i.test(command)) {
      prefixArgs = [command];
      command = process.execPath;
    }
  } else {
    const pathValue = env.PATH ?? env.Path ?? "";
    const dirs = pathValue.split(path.delimiter).filter(Boolean);
    if (platform === "win32") {
      const exe = dirs.map((d) => path.join(d, "codex.exe")).find((p) => fs.existsSync(p));
      if (exe) { command = exe; source = "PATH"; }
      else {
        const shim = dirs.flatMap((d) => [path.join(d, "codex.cmd"), path.join(d, "codex.ps1")])
          .find((p) => fs.existsSync(p));
        if (shim) return { ok: false, reason: "unsupported_shim", detail: `Found ${shim}; set CODEX_BIN to codex.exe or the npm package's JavaScript entry.` };
        return { ok: false, reason: "missing", detail: "codex.exe was not found on PATH" };
      }
    } else {
      const candidate = dirs.map((d) => path.join(d, "codex")).find((p) => {
        try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
      });
      if (!candidate) return { ok: false, reason: "missing", detail: "codex was not found on PATH" };
      command = candidate;
      source = "PATH";
    }
  }

  const probe = spawnSync(command, [...prefixArgs, "--version"], {
    encoding: "utf8", timeout: 10000, windowsHide: true, shell: false
  });
  if (probe.error?.code === "ENOENT") return { ok: false, reason: "missing", detail: probe.error.message };
  if (probe.error || probe.status !== 0) {
    const detail = probe.error?.message || probe.stderr?.trim() || `--version exited with ${probe.status}`;
    return { ok: false, reason: "broken", detail };
  }
  return { ok: true, command, prefixArgs, source };
}

/**
 * Build the fixed argument vector for one `codex exec` call.
 * Input: cwd, model, effort, sandbox and last-message path. Output: string[]; rejects unsafe sandbox values.
 */
export function buildExecArgs({ cwd, model, effort, sandbox, lastMessageFile }) {
  if (sandbox !== "read-only" && sandbox !== "workspace-write") throw new Error(`unsupported sandbox: ${sandbox}`);
  return ["exec", "--json", "--skip-git-repo-check", "-s", sandbox, "-m", model,
    "-c", `model_reasoning_effort=${effort}`, "-c", "approval_policy=never", "-C", cwd,
    "-o", lastMessageFile, "-"];
}

/**
 * Summarize a Codex JSONL event stream.
 * Input: stdout text. Output: thread, completed turns and usage, failures, warnings, malformed lines, commands and file changes.
 */
export function summarizeEvents(text) {
  const out = { thread_id: null, turns_completed: 0,
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
    failures: [], warnings: 0, malformed_lines: 0, commands: 0, file_changes: 0 };
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { out.malformed_lines++; continue; }
    if (event.type === "thread.started") out.thread_id = event.thread_id ?? out.thread_id;
    if (event.type === "turn.completed") {
      out.turns_completed++;
      const usage = event.usage ?? {};
      out.usage.input_tokens += Number(usage.input_tokens) || 0;
      out.usage.cached_input_tokens += Number(usage.cached_input_tokens) || 0;
      out.usage.output_tokens += Number(usage.output_tokens) || 0;
      out.usage.reasoning_output_tokens += Number(usage.reasoning_output_tokens) || 0;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      if (event.error?.message || event.message) out.failures.push(event.error?.message ?? event.message);
    }
    if (event.type === "item.completed") {
      const item = event.item ?? {};
      if (item.type === "error") out.warnings++;
      if (item.type === "command_execution") out.commands++;
      if (item.type?.includes("file_change") || item.type === "file_change") out.file_changes++;
    }
  }
  return out;
}

/**
 * Normalize runner state and event summary into a stable backend result.
 * Input: state, events and final-message existence. Output: { status, failure_hint, reasons[] } using documented precedence.
 */
export function normalizeExecResult({ state, events, finalMessageExists }) {
  const reasons = [];
  let status = "completed";
  let failure_hint = null;
  const add = (reason, hint, result = "failed") => {
    reasons.push(reason);
    if (reasons.length === 1) { status = result; failure_hint = hint; }
  };
  if (state.status === "cancelled") add("cancelled", null, "cancelled");
  if (state.spawn_error || state.io_error) add("tool_error", "tool_error");
  if (state.status === "lost") add("runner_lost", "runner_lost");
  if (state.signal) add("killed", "killed");
  if (events.failures?.length) add("turn_failed", events.failures.some(looksLikeQuotaStop) ? "quota" : "turn_failed");
  if (state.exit_code !== 0) add("exit_code", "exit_code");
  if (events.turns_completed === 0) add("no_turn_completed", "no_turn_completed");
  if (!reasons.length && !finalMessageExists) reasons.push("no_final_message");
  return { status, failure_hint, reasons };
}

/**
 * Create a job and launch its detached runner.
 * Input: job paths, command vector, cwd and optional startup timeout. Output: Promise<{ state }> after runner acknowledgement or timeout.
 */
export async function submitJob({ jobDir, command, prefixArgs = [], args, cwd, promptFile, startupTimeoutMs = 10000 }) {
  fs.mkdirSync(jobDir, { recursive: true });
  const absDir = path.resolve(jobDir);
  atomicJson(path.join(absDir, "spec.json"), { command, prefixArgs, args, cwd, promptFile, env_unset: [] });
  atomicJson(path.join(absDir, "state.json"), { status: "pending", submitted_at: new Date().toISOString(),
    runner_pid: null, child_pid: null, started_at: null, finished_at: null, exit_code: null,
    signal: null, spawn_error: null, io_error: null });
  const runner = spawn(process.execPath, [RUNNER, absDir], { detached: true, stdio: "ignore", windowsHide: true, shell: false });
  runner.unref();
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const state = readState(absDir);
    if (state.status !== "pending") return { state };
    await delay(100);
  }
  return { state: readState(absDir) };
}

/**
 * Read poll-friendly job state and terminal outputs, detecting a dead running runner.
 * Input: job directory. Output: { state, events|null, finalMessage|null, stderrTail }.
 */
export function readJob(jobDir) {
  let state = readState(jobDir);
  if (state.status === "running" && state.runner_pid && !alive(state.runner_pid)) state = { ...state, status: "lost" };
  if (!terminal(state)) return { state, events: null, finalMessage: null, stderrTail: "" };
  const read = (file) => { try { return fs.readFileSync(path.join(jobDir, file), "utf8"); } catch { return ""; } };
  const stderr = read("stderr.txt");
  return { state, events: summarizeEvents(read("events.jsonl")), finalMessage: read("last-message.txt") || null,
    stderrTail: stderr.slice(-4096) };
}

/**
 * Poll a job until terminal, lost, or timeout.
 * Input: job directory and timeoutMs. Output: Promise<readJob result>, including the current state on timeout.
 */
export async function waitJob(jobDir, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = readJob(jobDir);
    if (terminal(result.state) || result.state.status === "lost" || Date.now() >= deadline) return result;
    await delay(500);
  }
}

function writeTerminal(jobDir, state, status, extra = {}) {
  if (terminal(state)) return state;
  const next = { ...state, ...extra, status, finished_at: new Date().toISOString() };
  atomicJson(path.join(jobDir, "state.json"), next);
  return next;
}

function windowsTreePids(rootPid) {
  const query = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"],
  { encoding: "utf8", windowsHide: true, shell: false, timeout: 10000 });
  if (query.status !== 0 || !query.stdout) return [rootPid];
  try {
    const rows = JSON.parse(query.stdout);
    const byParent = new Map();
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      const parent = Number(row.ParentProcessId);
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(Number(row.ProcessId));
    }
    const found = [];
    const visit = (pid) => {
      for (const child of byParent.get(pid) || []) visit(child);
      found.push(pid);
    };
    visit(rootPid);
    return found;
  } catch { return [rootPid]; }
}

function killWindows(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true, shell: false });
  if (result.status === 0 || !alive(pid)) return true;
  // Some managed Windows sessions deny taskkill for detached children while still permitting
  // the owning process to open and terminate them. Walk the parent tree and try direct termination.
  for (const target of windowsTreePids(pid)) {
    if (!alive(target)) continue;
    try { process.kill(target, "SIGKILL"); } catch {}
  }
  return !windowsTreePids(pid).some(alive);
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; }
  catch (e) { return !alive(pid) || e.code === "ESRCH"; }
}

/**
 * Request cancellation, kill the runner process tree, and verify both processes stopped.
 * Input: job directory and optional graceMs. Output: Promise<{ ok, status, detail? }>.
 */
export async function cancelJob(jobDir, { graceMs = 5000 } = {}) {
  let state = readState(jobDir);
  if (terminal(state)) return { ok: false, status: state.status };
  fs.writeFileSync(path.join(jobDir, "cancel.request"), `${new Date().toISOString()}\n`);
  const deadline = Date.now() + 10000;
  if (state.runner_pid) {
    if (process.platform === "win32") killWindows(state.runner_pid);
    else signalGroup(state.runner_pid, "SIGTERM");
    await delay(graceMs);
    state = readState(jobDir);
    if (process.platform === "win32") {
      for (const pid of [state.runner_pid, state.child_pid]) if (alive(pid)) killWindows(pid);
    } else if (alive(state.runner_pid)) signalGroup(state.runner_pid, "SIGKILL");
  }
  while (Date.now() < deadline) {
    state = readState(jobDir);
    if (terminal(state)) return { ok: state.status === "cancelled", status: state.status };
    const runnerAlive = alive(state.runner_pid);
    const childAlive = alive(state.child_pid);
    if (!runnerAlive && !childAlive) {
      const next = writeTerminal(jobDir, state, "cancelled");
      return { ok: true, status: next.status };
    }
    if (process.platform === "win32") {
      for (const pid of [state.runner_pid, state.child_pid]) if (alive(pid)) killWindows(pid);
    } else if (state.runner_pid && alive(state.runner_pid)) signalGroup(state.runner_pid, "SIGKILL");
    await delay(100);
  }
  return { ok: false, status: readState(jobDir).status, detail: "processes did not stop within 10 seconds" };
}

/**
 * Stop a surviving Codex child and mark a lost runner failed.
 * Input: job directory in lost state. Output: Promise<failed state> after child termination is verified.
 */
export async function reconcileLost(jobDir) {
  let state = readState(jobDir);
  if (terminal(state)) return state;
  const killTree = (pid) => {
    if (!alive(pid)) return;
    if (process.platform === "win32") killWindows(pid);
    else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } }
  };
  killTree(state.child_pid);
  const deadline = Date.now() + 10000;
  while (alive(state.child_pid) && Date.now() < deadline) await delay(100);
  if (alive(state.child_pid)) throw new Error(`could not stop child process ${state.child_pid}`);
  state = readState(jobDir);
  if (!terminal(state)) state = writeTerminal(jobDir, state, "failed", { io_error: "runner lost" });
  return state;
}
