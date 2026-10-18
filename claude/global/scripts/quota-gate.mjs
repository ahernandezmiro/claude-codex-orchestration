// Codex quota gate for codex-delegate.mjs: reads the account's rate-limit window and decides,
// without any model judgment, whether a delegation may start.
// Author: maintained with Claude Code for the frontier-model orchestration setup.
//
// Sources, in order:
//   1. CODEX_QUOTA_SNAPSHOT=<file.json>  test/override hook: { usedPercent, windowMinutes, resetsAt }
//   2. live: `codex app-server` JSON-RPC `account/rateLimits/read` (same numbers as /status)
//   3. fallback: the newest `rate_limits` snapshot in $CODEX_HOME/sessions rollouts, only while
//      its window has not reset (a lower bound: usage since that snapshot is not included)
// No source -> the gate blocks (fails closed).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const QUOTA_BLOCKED_EXIT_CODE = 5;
const ONGOING_STATUSES = ["running", "submitted_background"];

/**
 * Load the quota rules.
 * Input: file path of config/quota.json, list of known role names.
 * Output: { windowMinutes, readTimeoutMs, roles: { <role>: percent } }.
 * Throws Error naming the file on a missing file, bad JSON, unknown/missing role or non-numeric value.
 */
export function loadQuotaRules(file, roleNames) {
  if (!fs.existsSync(file)) throw new Error(`quota config not found: ${file} (re-run the deploy script)`);
  let config;
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`invalid JSON in ${file}: ${e.message}`); }
  const roles = config.roles ?? {};
  for (const name of Object.keys(roles)) {
    if (!roleNames.includes(name)) throw new Error(`${file}: unknown role '${name}'`);
  }
  for (const name of roleNames) {
    const v = roles[name];
    if (typeof v !== "number" || !(v >= 0 && v <= 100)) throw new Error(`${file}: role '${name}' needs a percent between 0 and 100 (got ${JSON.stringify(v)})`);
  }
  const windowMinutes = config.window_minutes ?? 300;
  const readTimeoutMs = config.read_timeout_ms ?? 20000;
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1) throw new Error(`${file}: window_minutes must be a positive integer`);
  if (!Number.isInteger(readTimeoutMs) || readTimeoutMs < 1000) throw new Error(`${file}: read_timeout_ms must be an integer >= 1000`);
  return { windowMinutes, readTimeoutMs, roles };
}

/**
 * Pick the window of the requested length from an app-server or rollout rate-limit object.
 * Input: rate-limit object with primary/secondary windows (camelCase or snake_case), window length.
 * Output: { usedPercent, windowMinutes, resetsAt } or null when no window has that length.
 */
function pickWindow(limits, windowMinutes) {
  for (const w of [limits?.primary, limits?.secondary]) {
    if (!w) continue;
    const minutes = w.windowDurationMins ?? w.window_minutes;
    if (minutes === windowMinutes) {
      return { usedPercent: Number(w.usedPercent ?? w.used_percent), windowMinutes: minutes, resetsAt: w.resetsAt ?? w.resets_at ?? null };
    }
  }
  return null;
}

/**
 * Ask a short-lived `codex app-server` for the account rate limits.
 * Input: { windowMinutes, timeoutMs }. Output: Promise<snapshot with source "live">.
 * Rejects on spawn failure, timeout, RPC error or a response without the requested window.
 */
function readLiveSnapshot({ windowMinutes, timeoutMs }) {
  const bin = process.env.CODEX_BIN || "codex";
  const attempt = (useShell) => new Promise((resolve, reject) => {
    // The shell retry is only for npm's codex.cmd shim on Windows; no caller data is in the args.
    const options = { stdio: ["pipe", "pipe", "ignore"], windowsHide: true };
    const child = useShell
      ? spawn(`"${bin}" app-server`, { ...options, shell: true })
      : spawn(bin, ["app-server"], options);
    let buffer = "";
    const finish = (fn, value) => { clearTimeout(timer); child.kill(); fn(value); };
    const timer = setTimeout(() => finish(reject, new Error(`codex app-server did not answer within ${timeoutMs} ms`)), timeoutMs);
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
    child.on("error", (e) => finish(reject, e));
    child.stdin.on("error", () => { /* surfaced through 'error'/'exit' */ });
    child.on("exit", () => finish(reject, new Error("codex app-server exited before answering")));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(reject, new Error(`initialize failed: ${JSON.stringify(message.error)}`));
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (message.id === 2) {
          if (message.error) return finish(reject, new Error(`account/rateLimits/read failed: ${JSON.stringify(message.error)}`));
          const result = message.result ?? {};
          const window = pickWindow(result.rateLimitsByLimitId?.codex ?? result.rateLimits, windowMinutes);
          if (!window) return finish(reject, new Error(`no ${windowMinutes}-minute window in rate-limit response`));
          return finish(resolve, { ...window, source: "live" });
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "codex-delegate-quota-gate", version: "1" } } });
  });
  return attempt(false).catch((e) => {
    if (process.platform === "win32" && e.code === "ENOENT") return attempt(true);
    throw e;
  });
}

/**
 * Newest rollout rate-limit snapshot whose window is still open.
 * Input: { windowMinutes, nowMs, codexHome }. Output: snapshot with source "rollout:<file>" or null.
 * Only the most recent day directories are scanned, newest file first.
 */
export function readRolloutSnapshot({ windowMinutes, nowMs = Date.now(), codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex") }) {
  const sessions = path.join(codexHome, "sessions");
  const children = (dir) => { try { return fs.readdirSync(dir).sort().reverse().map((n) => path.join(dir, n)); } catch { return []; } };
  const files = [];
  for (const year of children(sessions)) {
    for (const month of children(year)) {
      for (const day of children(month)) {
        files.push(...children(day).filter((f) => f.endsWith(".jsonl")));
      }
      if (files.length >= 20) break;
    }
    if (files.length >= 20) break;
  }
  const byMtime = files
    .map((f) => { try { return { f, mtime: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 20);
  for (const { f } of byMtime) {
    let lines;
    try { lines = fs.readFileSync(f, "utf8").split(/\r?\n/).reverse(); } catch { continue; }
    for (const line of lines) {
      if (!line.includes("\"rate_limits\"")) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const window = pickWindow(entry.payload?.rate_limits ?? entry.rate_limits, windowMinutes);
      if (!window) continue;
      // A reset window makes the snapshot meaningless: usage since the reset is unknown.
      if (window.resetsAt == null || window.resetsAt * 1000 <= nowMs) return null;
      return { ...window, source: `rollout:${f}` };
    }
  }
  return null;
}

/**
 * Read the current window usage from the first source that answers.
 * Input: { windowMinutes, readTimeoutMs }. Output: Promise<{ snapshot|null, errors: string[] }>.
 */
export async function readQuotaSnapshot({ windowMinutes, readTimeoutMs }) {
  const errors = [];
  if (process.env.CODEX_QUOTA_SNAPSHOT) {
    try {
      const s = JSON.parse(fs.readFileSync(process.env.CODEX_QUOTA_SNAPSHOT, "utf8"));
      return { snapshot: { usedPercent: Number(s.usedPercent), windowMinutes: s.windowMinutes ?? windowMinutes, resetsAt: s.resetsAt ?? null, source: `file:${process.env.CODEX_QUOTA_SNAPSHOT}` }, errors };
    } catch (e) {
      errors.push(`CODEX_QUOTA_SNAPSHOT: ${e.message}`);
      return { snapshot: null, errors };
    }
  }
  try {
    return { snapshot: await readLiveSnapshot({ windowMinutes, timeoutMs: readTimeoutMs }), errors };
  } catch (e) {
    errors.push(`live: ${e.message}`);
  }
  const rollout = readRolloutSnapshot({ windowMinutes });
  if (rollout) return { snapshot: rollout, errors };
  errors.push("rollout: no snapshot with an open window");
  return { snapshot: null, errors };
}

/**
 * Runs that still hold a reservation.
 * Input: run records, rules, nowMs. Output: [{ run_id, role, status, started_at, reserved }].
 * A run older than one window is ignored, so a crashed or never-collected run cannot block forever.
 */
export function ongoingReservations(runs, rules, nowMs = Date.now()) {
  const windowMs = rules.windowMinutes * 60 * 1000;
  return runs
    .filter((r) => ONGOING_STATUSES.includes(r.status) && nowMs - Date.parse(r.started_at || 0) < windowMs)
    .map((r) => ({ run_id: r.run_id, role: r.role, status: r.status, started_at: r.started_at, reserved: rules.roles[r.role] ?? 0 }));
}

/**
 * The gate itself. Pure.
 * Input: { role, snapshot|null, ongoing, rules }.
 * Output: { allowed, role, required, remaining, reserved, effective, margin, reason }.
 * effective = remaining - reserved; allowed iff effective - required > 0.
 */
export function evaluateQuotaGate({ role, snapshot, ongoing, rules }) {
  const required = rules.roles[role];
  const reserved = ongoing.reduce((sum, r) => sum + r.reserved, 0);
  if (!snapshot || !Number.isFinite(snapshot.usedPercent)) {
    return { allowed: false, role, required, remaining: null, reserved, effective: null, margin: null, reason: "quota unknown (no source answered)" };
  }
  const remaining = Math.max(0, 100 - snapshot.usedPercent);
  const effective = remaining - reserved;
  const margin = effective - required;
  const allowed = margin > 0;
  const reason = allowed
    ? `effective ${effective}% > ${required}% required`
    : `effective ${effective}% <= ${required}% required`;
  return { allowed, role, required, remaining, reserved, effective, margin, reason };
}

/**
 * One-line, model-readable verdict for the terminal.
 * Input: gate decision, snapshot|null, ongoing list. Output: string.
 */
export function formatGateLine(decision, snapshot, ongoing) {
  const counts = {};
  for (const r of ongoing) counts[r.role] = (counts[r.role] ?? 0) + 1;
  const ongoingText = Object.entries(counts).map(([role, n]) => `${n}x ${role}`).join(", ") || "none";
  const resets = snapshot?.resetsAt ? new Date(snapshot.resetsAt * 1000).toISOString() : "unknown";
  const head = decision.allowed ? "QUOTA GATE: OK" : "QUOTA GATE: BLOCKED";
  return `${head} role=${decision.role} — ${decision.reason}; window=${snapshot?.windowMinutes ?? "?"}m remaining=${decision.remaining ?? "?"}% reserved=${decision.reserved}% (ongoing: ${ongoingText}) resets=${resets} source=${snapshot?.source ?? "none"}`;
}
