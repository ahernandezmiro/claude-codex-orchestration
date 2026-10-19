#!/usr/bin/env node
// Offline estimate of orchestrator (Claude) token use spent reviewing/reworking each delegated run.
// Author: maintained with Claude Code for the frontier-model orchestration setup.
//
//   node opus-usage.mjs [--runs-dir <dir>] [--projects-dir <dir>] [--json]
//
// For every assessed run it sums the usage of Claude assistant messages in the Claude Code
// session transcripts (<home>/.claude/projects/**/*.jsonl) whose cwd is inside the run's repo
// and whose timestamp falls between the worker result (finished_at / collected_at) and the
// assessment. That window is Opus's review + correction effort for the run.
//
// Limits, by construction: work done before dispatch (packet writing) is not counted; runs in
// the same repo with overlapping windows share tokens (flagged `overlap`); transcripts only
// exist on the machine that ran the session. Read-only: nothing is written anywhere.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (key === "json") options.json = true;
    else options[key] = argv[++i];
  }
  return options;
}

function walk(dir, suffix, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "_validation") walk(p, suffix, out); }
    else if (e.name.endsWith(suffix)) out.push(p);
  }
  return out;
}

// Case- and separator-insensitive on Windows; exact elsewhere.
const norm = (p) => {
  const s = String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
};
const inside = (child, parent) => child === parent || child.startsWith(`${parent}/`);

/**
 * Load runs that have a review window. Input: runs dir.
 * Output: [{ run_id, role, root, from, to }] with from/to in ms, deduplicated by run id.
 */
export function loadRunWindows(runsDir) {
  const byId = new Map();
  for (const file of walk(runsDir, ".run.json")) {
    let r;
    try { r = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    const fromIso = r.collected_at || r.finished_at;
    const toIso = r.assessment?.assessed_at;
    if (!fromIso || !toIso || Date.parse(toIso) <= Date.parse(fromIso)) continue;
    byId.set(r.run_id, {
      run_id: r.run_id, role: r.role, outcome: r.assessment.outcome,
      root: norm(r.git_root || r.cwd), from: Date.parse(fromIso), to: Date.parse(toIso)
    });
  }
  return [...byId.values()];
}

/**
 * Stream transcripts and collect one usage record per assistant message id.
 * Input: projects dir. Output: Promise<[{ ts, cwd, model, input, cache_creation, cache_read, output }]>.
 */
export async function loadUsage(projectsDir) {
  const seen = new Set();
  const out = [];
  for (const file of walk(projectsDir, ".jsonl")) {
    const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const msg = rec.message;
      if (rec.type !== "assistant" || !msg?.usage || !rec.timestamp) continue;
      // A response streamed as several lines repeats the same id and usage.
      const id = msg.id || `${file}:${rec.uuid}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const u = msg.usage;
      out.push({
        ts: Date.parse(rec.timestamp), cwd: norm(rec.cwd), model: msg.model || "unknown",
        input: u.input_tokens || 0, cache_creation: u.cache_creation_input_tokens || 0,
        cache_read: u.cache_read_input_tokens || 0, output: u.output_tokens || 0
      });
    }
  }
  return out;
}

/** Attribute usage records to run windows. Input: windows, usage. Output: per-run rows. */
export function attribute(windows, usage) {
  return windows.map((w) => {
    const hits = usage.filter((u) => u.ts >= w.from && u.ts <= w.to && u.cwd && inside(u.cwd, w.root));
    const sum = (k) => hits.reduce((s, u) => s + u[k], 0);
    const overlap = windows.some((o) => o.run_id !== w.run_id && o.root === w.root && o.from < w.to && o.to > w.from);
    return {
      run_id: w.run_id, role: w.role, outcome: w.outcome,
      window_min: Math.round((w.to - w.from) / 60000),
      messages: hits.length, input: sum("input"), cache_creation: sum("cache_creation"),
      cache_read: sum("cache_read"), output: sum("output"), overlap
    };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const runsDir = path.resolve(options["runs-dir"] || path.join(KIT_ROOT, "runs"));
  const projectsDir = path.resolve(options["projects-dir"] || path.join(os.homedir(), ".claude", "projects"));
  const rows = attribute(loadRunWindows(runsDir), await loadUsage(projectsDir));
  if (options.json) console.log(JSON.stringify(rows, null, 2));
  else {
    const cols = ["role", "outcome", "window_min", "messages", "input", "cache_creation", "cache_read", "output", "overlap"];
    console.log(["run_id", ...cols].join("\t"));
    for (const r of rows) console.log([r.run_id, ...cols.map((c) => r[c])].join("\t"));
    const matched = rows.filter((r) => r.messages > 0).length;
    console.log(`\n${rows.length} assessed run(s); ${matched} matched transcript messages in ${projectsDir}`);
  }
}
