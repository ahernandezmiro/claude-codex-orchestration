// Tests for the Codex quota gate (scripts/quota-gate.mjs) and its wiring into codex-delegate.mjs.
// Author: maintained with Claude Code for the frontier-model orchestration setup.
//
//   node --test claude/global/test/quota-gate.test.mjs
//
// The CLI tests stage the installed layout in a temp dir and feed the gate through
// CODEX_QUOTA_SNAPSHOT, so they never contact Codex and never touch real telemetry.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  evaluateQuotaGate, ongoingReservations, loadQuotaRules, readRolloutSnapshot
} from "../scripts/quota-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLOBAL = path.resolve(HERE, "..");
const REPO = path.resolve(GLOBAL, "..", "..");
const ROLE_NAMES = ["luna-implement", "luna-test", "sol-implement", "astra-review", "astra-investigate"];
const RULES = loadQuotaRules(path.join(GLOBAL, "config", "quota.json"), ROLE_NAMES);
const NOW = Date.parse("2026-10-18T12:00:00Z");

const snapshot = (usedPercent) => ({ usedPercent, windowMinutes: 300, resetsAt: NOW / 1000 + 3600, source: "test" });
const ongoing = (...roles) => roles.map((role, i) => ({ run_id: `r${i}`, role, reserved: RULES.roles[role] }));

test("shipped rules match the requested thresholds", () => {
  assert.deepEqual(RULES.roles, { "astra-review": 25, "astra-investigate": 25, "sol-implement": 15, "luna-implement": 10, "luna-test": 10 });
  assert.equal(RULES.windowMinutes, 300);
});

test("thresholds are strict: equal to the requirement blocks", () => {
  assert.equal(evaluateQuotaGate({ role: "astra-review", snapshot: snapshot(75), ongoing: [], rules: RULES }).allowed, false);
  assert.equal(evaluateQuotaGate({ role: "astra-review", snapshot: snapshot(74), ongoing: [], rules: RULES }).allowed, true);
  assert.equal(evaluateQuotaGate({ role: "sol-implement", snapshot: snapshot(85), ongoing: [], rules: RULES }).allowed, false);
  assert.equal(evaluateQuotaGate({ role: "sol-implement", snapshot: snapshot(84), ongoing: [], rules: RULES }).allowed, true);
  assert.equal(evaluateQuotaGate({ role: "luna-implement", snapshot: snapshot(90), ongoing: [], rules: RULES }).allowed, false);
  assert.equal(evaluateQuotaGate({ role: "luna-test", snapshot: snapshot(89), ongoing: [], rules: RULES }).allowed, true);
});

test("ongoing calls reserve 25/15/10 from the real remaining quota", () => {
  // 60% remaining - (25 + 15 + 10) = 10% effective: Luna needs > 10, so blocked.
  const d = evaluateQuotaGate({ role: "luna-implement", snapshot: snapshot(40), ongoing: ongoing("astra-review", "sol-implement", "luna-test"), rules: RULES });
  assert.equal(d.remaining, 60);
  assert.equal(d.reserved, 50);
  assert.equal(d.effective, 10);
  assert.equal(d.allowed, false);
  // 61% remaining leaves 11% effective: allowed.
  assert.equal(evaluateQuotaGate({ role: "luna-implement", snapshot: snapshot(39), ongoing: ongoing("astra-review", "sol-implement", "luna-test"), rules: RULES }).allowed, true);
  // Reservations above the remaining quota go negative and block everything.
  const neg = evaluateQuotaGate({ role: "luna-test", snapshot: snapshot(70), ongoing: ongoing("astra-review", "astra-investigate"), rules: RULES });
  assert.equal(neg.effective, -20);
  assert.equal(neg.allowed, false);
});

test("unknown quota fails closed", () => {
  const d = evaluateQuotaGate({ role: "luna-test", snapshot: null, ongoing: [], rules: RULES });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /unknown/);
});

test("only running/background runs inside the window reserve quota", () => {
  const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
  const runs = [
    { run_id: "a", role: "astra-review", status: "running", started_at: hoursAgo(1) },
    { run_id: "b", role: "luna-implement", status: "submitted_background", started_at: hoursAgo(4.9) },
    { run_id: "c", role: "sol-implement", status: "submitted_background", started_at: hoursAgo(5.1) },
    { run_id: "d", role: "luna-test", status: "completed", started_at: hoursAgo(0.1) },
    { run_id: "e", role: "luna-test", status: "dry_run", started_at: hoursAgo(0.1) }
  ];
  const result = ongoingReservations(runs, RULES, NOW);
  assert.deepEqual(result.map((r) => [r.run_id, r.reserved]), [["a", 25], ["b", 10]]);
});

test("config errors are reported with the file name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-cfg-"));
  const file = path.join(dir, "quota.json");
  fs.writeFileSync(file, JSON.stringify({ roles: { "luna-implement": 10 } }));
  assert.throws(() => loadQuotaRules(file, ROLE_NAMES), /quota\.json: role 'luna-test'/);
  fs.writeFileSync(file, JSON.stringify({ roles: { ...RULES.roles, bogus: 1 } }));
  assert.throws(() => loadQuotaRules(file, ROLE_NAMES), /unknown role 'bogus'/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rollout fallback uses the newest snapshot only while its window is open", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "quota-home-"));
  const day = path.join(home, "sessions", "2026", "10", "18");
  fs.mkdirSync(day, { recursive: true });
  const line = (used, resetsAt) => JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", rate_limits: {
      primary: { used_percent: used, window_minutes: 300, resets_at: resetsAt },
      secondary: { used_percent: 3, window_minutes: 10080, resets_at: resetsAt + 99999 }
    } }
  });
  const file = path.join(day, "rollout-a.jsonl");
  fs.writeFileSync(file, [line(20, NOW / 1000 + 600), line(37, NOW / 1000 + 600)].join("\n") + "\n");
  const open = readRolloutSnapshot({ windowMinutes: 300, nowMs: NOW, codexHome: home });
  assert.equal(open.usedPercent, 37);
  assert.match(open.source, /^rollout:/);
  assert.equal(readRolloutSnapshot({ windowMinutes: 300, nowMs: NOW + 3600 * 1000, codexHome: home }), null);
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * Stage scripts + docs + config like the installed ~/.claude/orchestration layout.
 * Input: none. Output: { stage, companion, wrapper } paths; caller removes stage.
 */
function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-stage-"));
  for (const [src, dst] of [["shared", "shared"], ["codex", "codex"], ["claude/global/scripts", "scripts"], ["claude/global/config", "config"]]) {
    fs.cpSync(path.join(REPO, src), path.join(dir, dst), { recursive: true });
  }
  fs.rmSync(path.join(dir, "config", "models.local.json"), { force: true });
  const companion = path.join(dir, "stub-codex-companion.mjs");
  fs.writeFileSync(companion, "process.exit(99);\n");
  return { stage: dir, companion, wrapper: path.join(dir, "scripts", "codex-delegate.mjs") };
}

/**
 * Run the staged wrapper with a fixed quota snapshot.
 * Input: staged layout, role, used percent. Output: spawnSync result.
 */
function runWithQuota(s, role, usedPercent) {
  const snap = path.join(s.stage, "snapshot.json");
  fs.writeFileSync(snap, JSON.stringify({ usedPercent, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }));
  const packet = role.startsWith("astra") ? "R001-slug-registry.yaml" : "T001-slugify.yaml";
  return spawnSync(process.execPath, [s.wrapper, "run", "--role", role, "--packet", path.join(HERE, packet), "--cwd", s.stage], {
    encoding: "utf8", env: { ...process.env, CODEX_COMPANION: s.companion, CODEX_QUOTA_SNAPSHOT: snap }
  });
}

test("CLI: a blocked run exits 5, creates no run record and logs a telemetry event", () => {
  const s = stage();
  try {
    const r = runWithQuota(s, "astra-review", 80);
    assert.equal(r.status, 5, r.stdout + r.stderr);
    assert.match(r.stdout, /QUOTA GATE: BLOCKED role=astra-review/);
    assert.doesNotMatch(r.stdout, /DELEGATE: run=/);
    const runs = fs.existsSync(path.join(s.stage, "runs")) ? fs.readdirSync(path.join(s.stage, "runs")) : [];
    assert.deepEqual(runs, []);
    const events = fs.readFileSync(path.join(s.stage, "telemetry", "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.at(-1).type, "quota_gate_blocked");
    assert.equal(events.at(-1).quota_gate.effective, 20);
  } finally { fs.rmSync(s.stage, { recursive: true, force: true }); }
});

test("CLI: an allowed run records the gate, and its reservation blocks the next call", () => {
  const s = stage();
  try {
    const first = runWithQuota(s, "luna-implement", 70);
    assert.match(first.stdout, /QUOTA GATE: OK role=luna-implement/);
    assert.equal(first.status, 99, "reaches the stub companion");
    const [runFile] = fs.readdirSync(path.join(s.stage, "runs")).filter((f) => f.endsWith(".run.json"));
    const run = JSON.parse(fs.readFileSync(path.join(s.stage, "runs", runFile), "utf8"));
    assert.equal(run.quota_gate.allowed, true);
    assert.equal(run.quota_gate.effective, 30);
    // Simulate that run still being in flight: 30% remaining - 10% reserved = 20% <= 25% for Astra.
    fs.writeFileSync(path.join(s.stage, "runs", runFile), JSON.stringify({ ...run, status: "running" }));
    const second = runWithQuota(s, "astra-review", 70);
    assert.equal(second.status, 5, second.stdout + second.stderr);
    assert.match(second.stdout, /reserved=10% \(ongoing: 1x luna-implement\)/);
  } finally { fs.rmSync(s.stage, { recursive: true, force: true }); }
});

test("CLI: dry runs skip the gate entirely", () => {
  const s = stage();
  try {
    const r = runWithQuota(s, "astra-review", 100);
    assert.equal(r.status, 5);
    const dry = spawnSync(process.execPath, [s.wrapper, "run", "--role", "astra-review", "--packet", path.join(HERE, "R001-slug-registry.yaml"), "--cwd", s.stage, "--dry-run"], {
      encoding: "utf8", env: { ...process.env, CODEX_COMPANION: s.companion, CODEX_QUOTA_SNAPSHOT: path.join(s.stage, "snapshot.json") }
    });
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.doesNotMatch(dry.stdout, /QUOTA GATE/);
  } finally { fs.rmSync(s.stage, { recursive: true, force: true }); }
});
