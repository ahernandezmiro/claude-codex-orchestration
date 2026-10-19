// Detached per-job supervisor for exec-backend.mjs. Keeps Codex stdout/stderr on disk and
// reports state with atomic replacements so callers can poll without reading partial JSON.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const jobDir = path.resolve(process.argv[2] || ".");
const stateFile = path.join(jobDir, "state.json");
const terminal = new Set(["completed", "failed", "cancelled"]);

function readState() {
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function writeState(state) {
  const tmp = `${stateFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, stateFile);
}

function hasCancel() {
  return fs.existsSync(path.join(jobDir, "cancel.request"));
}

function finish(status, fields = {}) {
  const current = readState();
  if (terminal.has(current.status)) return;
  writeState({ ...current, ...fields, status, finished_at: new Date().toISOString() });
}

async function run() {
  const spec = JSON.parse(fs.readFileSync(path.join(jobDir, "spec.json"), "utf8"));
  let state = readState();
  if (terminal.has(state.status)) return;
  if (hasCancel()) { finish("cancelled"); return; }
  if (state.status !== "pending") return;
  state = { ...state, status: "running", runner_pid: process.pid, started_at: new Date().toISOString() };
  writeState(state);
  if (hasCancel()) { finish("cancelled"); return; }

  let promptFd;
  let eventsFd;
  let stderrFd;
  try {
    promptFd = fs.openSync(spec.promptFile, "r");
    eventsFd = fs.openSync(path.join(jobDir, "events.jsonl"), "w");
    stderrFd = fs.openSync(path.join(jobDir, "stderr.txt"), "w");
  } catch (error) {
    for (const fd of [promptFd, eventsFd, stderrFd]) if (fd != null) try { fs.closeSync(fd); } catch {}
    finish("failed", { io_error: error.message });
    return;
  }

  let child;
  let spawnError = null;
  try {
    child = spawn(spec.command, [...(spec.prefixArgs || []), ...spec.args], {
      cwd: spec.cwd, env: { ...process.env }, stdio: [promptFd, eventsFd, stderrFd], shell: false,
      windowsHide: true, detached: false
    });
    const latest = readState();
    if (!terminal.has(latest.status)) writeState({ ...latest, child_pid: child.pid ?? null });
    child.once("error", (error) => { spawnError = error.message; });
    const closed = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    const latestState = readState();
    const fields = { exit_code: closed.code, signal: closed.signal, ...(spawnError ? { spawn_error: spawnError } : {}) };
    if (hasCancel()) finish("cancelled", fields);
    else finish(!spawnError && closed.code === 0 ? "completed" : "failed", fields);
    if (latestState.status === "cancelled") return;
  } catch (error) {
    finish("failed", { spawn_error: error.message });
  } finally {
    for (const fd of [promptFd, eventsFd, stderrFd]) if (fd != null) try { fs.closeSync(fd); } catch {}
  }
}

run().catch((error) => {
  try { finish("failed", { io_error: error.message }); } catch {}
  process.exitCode = 1;
});
