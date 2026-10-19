// Mechanical telemetry for codex-delegate.mjs: working-tree snapshots, worker/post-worker diff
// stats, completion-report parsing and grouped metrics. No model calls, no external packages.
// Author: maintained with Claude Code for the frontier-model orchestration setup.
//
// Snapshots hash the working tree (tracked + untracked, honoring .gitignore) into a git tree
// object through a temporary index. The user's index, refs, stash and HEAD are never touched;
// the only side effect is loose objects in the repo's object store, which `git gc` prunes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const VALID_CAUSES = [
  "model_error", "spec_error", "test_gap", "runtime_gap", "visual_fidelity", "tool_error", "quota", "concurrency"
];
export const VALID_VERIFIED = ["tests", "runtime", "visual", "none"];
export const UNFINALIZED_STATUSES = ["running", "submitted_background"];

function git(cwd, args, env) {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: env ?? process.env
  });
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/**
 * Hash the current working tree of a repo into a tree object.
 * Input: repo root. Output: tree id (string) or null when git fails.
 * Starts from a copy of the real index so unchanged tracked files reuse cached stat data.
 */
export function snapshotTree(root) {
  const indexRel = git(root, ["rev-parse", "--git-path", "index"]);
  if (!indexRel.ok) return null;
  const realIndex = path.resolve(root, indexRel.stdout.trim());
  const tmpIndex = path.join(os.tmpdir(), `orch-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    if (!git(root, ["add", "-A"], env).ok) return null;
    const tree = git(root, ["write-tree"], env);
    return tree.ok ? tree.stdout.trim() : null;
  } finally {
    fs.rmSync(tmpIndex, { force: true });
    fs.rmSync(`${tmpIndex}.lock`, { force: true });
  }
}

// Literal pathspecs so file names are never read as globs.
const literal = (files) => files.map((f) => `:(literal)${f}`);

/**
 * Repo-relative paths that differ between two trees.
 * Input: repo root, from tree, to tree. Output: string[] (empty on error).
 */
export function changedPaths(root, fromTree, toTree) {
  if (!fromTree || !toTree) return [];
  const r = git(root, ["diff", "--name-only", "-z", "--no-renames", fromTree, toTree]);
  return r.ok ? r.stdout.split("\0").filter(Boolean) : [];
}

/**
 * Line counts between two trees, optionally limited to some repo-relative files.
 * Input: repo root, from tree, to tree, files (null = whole tree).
 * Output: { files, lines_added, lines_removed, binary_files } or null on error.
 */
export function diffStat(root, fromTree, toTree, files = null) {
  const empty = { files: 0, lines_added: 0, lines_removed: 0, binary_files: 0 };
  if (!fromTree || !toTree) return null;
  if (files && files.length === 0) return empty;
  const args = ["diff", "--numstat", "-z", "--no-renames", fromTree, toTree];
  if (files) args.push("--", ...literal(files));
  const r = git(root, args);
  if (!r.ok) return null;
  const stat = { ...empty };
  // With -z each record is "added\tremoved\tpath\0".
  for (const record of r.stdout.split("\0").filter(Boolean)) {
    const [added, removed] = record.split("\t");
    stat.files++;
    if (added === "-" || removed === "-") stat.binary_files++;
    else {
      stat.lines_added += Number(added) || 0;
      stat.lines_removed += Number(removed) || 0;
    }
  }
  return stat;
}

/**
 * Parse the worker's final completion report (TASK_CONTRACT.md) out of its raw output.
 * Input: worker output text. Output: { status, checks: { pass, fail, not_run }, checks_executed }
 * or null when no report is found. Plain text matching; tolerant of extra prose and fences.
 */
export function parseWorkerReport(text) {
  if (!text) return null;
  const statusMatches = [...text.matchAll(/^\s*status:\s*["']?(completed|partial|blocked)\b/gm)];
  const checksAt = text.lastIndexOf("checks_run:");
  if (!statusMatches.length && checksAt < 0) return null;
  const checks = { pass: 0, fail: 0, not_run: 0 };
  if (checksAt >= 0) {
    const lines = text.slice(checksAt).split(/\r?\n/).slice(1);
    for (const line of lines) {
      // The block ends at the next top-level key or closing fence.
      if (/^[A-Za-z_][\w-]*:/.test(line) || /^```/.test(line)) break;
      const m = line.match(/\bresult:\s*["']?(pass|fail|not-run)\b/);
      if (m) checks[m[1] === "not-run" ? "not_run" : m[1]]++;
    }
  }
  return {
    status: statusMatches.length ? statusMatches[statusMatches.length - 1][1] : null,
    checks,
    checks_executed: checks.pass + checks.fail > 0
  };
}

/** Number of list items in a packet's `required_checks:` block text. Input: block text or null. */
export function countListItems(blockText) {
  if (!blockText) return 0;
  return blockText.split(/\r?\n/).slice(1).filter((l) => /^\s*-\s+\S/.test(l)).length;
}

/** True when worker output looks like a Codex usage/rate-limit stop. Input: text. */
export function looksLikeQuotaStop(text) {
  return /usage limit|rate[- ]limit|quota (?:exceeded|exhausted|reached)|you've hit your/i.test(text || "");
}

/**
 * Other runs in the same repo whose lifetime overlaps [run.started_at, untilIso] and that touched
 * at least one of the same files. Input: run, all runs, end ISO time. Output: run ids.
 */
export function overlappingRuns(run, runs, untilIso) {
  const start = Date.parse(run.started_at || 0);
  const until = Date.parse(untilIso);
  const mine = new Set(run.touched_files || []);
  return runs
    .filter((o) => o.run_id !== run.run_id && o.git_root && o.git_root === run.git_root && o.status !== "dry_run")
    .filter((o) => {
      const oStart = Date.parse(o.started_at || 0);
      const oEnd = o.finished_at ? Date.parse(o.finished_at) : Date.now();
      return oStart < until && oEnd > start;
    })
    .filter((o) => (o.touched_files || []).some((f) => mine.has(f)))
    .map((o) => o.run_id);
}

/** Lines changed (added + removed) in a diff stat, or 0. */
export const churn = (stat) => (stat ? stat.lines_added + stat.lines_removed : 0);

/** Worker runtime in ms: worker_duration_ms, else duration_ms for foreground runs only. */
export function workerDuration(run) {
  if (run.worker_duration_ms != null) return run.worker_duration_ms;
  // Background records written before schema 2 stored submission time in duration_ms.
  if (run.background && !run.collected_at && run.status !== "completed") return null;
  return run.duration_ms ?? null;
}

export function durationBucket(ms) {
  if (ms == null) return "unknown";
  const m = ms / 60000;
  return m < 5 ? "<5m" : m < 15 ? "5-15m" : m < 30 ? "15-30m" : "30m+";
}

export function projectOf(run) {
  // Split on both separators: packs mix Windows and POSIX paths whatever the analysing host is.
  return String(run.git_root || run.cwd || "unknown").split(/[\\/]+/).filter(Boolean).pop() || "unknown";
}

const GROUPERS = {
  role: (r) => [r.role || "unknown"],
  project: (r) => [projectOf(r)],
  task_type: (r) => [r.task_type || "unknown"],
  duration: (r) => [durationBucket(workerDuration(r))],
  outcome: (r) => [r.assessment?.outcome || "unassessed"],
  cause: (r) => (r.assessment?.cause?.length ? r.assessment.cause : ["none"])
};
export const GROUP_KEYS = Object.keys(GROUPERS);

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Group runs and summarize outcomes per group. A run with several causes counts in each.
 * Input: runs, group key (GROUP_KEYS). Output: [{ group, runs, assessed, accepted, minor_rework,
 * major_rework, failed, accepted_pct, verified_accepted, median_worker_min, worker_lines,
 * post_worker_lines, rewrite_ratio }], sorted by run count.
 */
export function groupMetrics(runs, by) {
  const key = GROUPERS[by];
  if (!key) throw new Error(`--by must be one of: ${GROUP_KEYS.join(", ")}`);
  const groups = new Map();
  for (const r of runs) for (const g of key(r)) {
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const rows = [];
  for (const [group, rs] of groups) {
    const assessed = rs.filter((r) => r.assessment);
    const count = (o) => assessed.filter((r) => r.assessment.outcome === o).length;
    const measured = assessed.filter((r) => r.worker_patch && r.post_worker);
    const workerLines = measured.reduce((s, r) => s + churn(r.worker_patch), 0);
    const postLines = measured.reduce((s, r) => s + churn(r.post_worker), 0);
    const durations = rs.map(workerDuration).filter((d) => d != null && d > 0);
    rows.push({
      group,
      runs: rs.length,
      assessed: assessed.length,
      accepted: count("accepted"),
      minor_rework: count("minor_rework"),
      major_rework: count("major_rework"),
      failed: count("failed"),
      accepted_pct: assessed.length ? Math.round((count("accepted") / assessed.length) * 100) : null,
      verified_accepted: assessed.filter((r) => r.assessment.outcome === "accepted"
        && (r.assessment.verified || []).some((v) => v !== "none")).length,
      median_worker_min: durations.length ? Math.round(median(durations) / 60000) : null,
      measured_runs: measured.length,
      worker_lines: workerLines,
      post_worker_lines: postLines,
      rewrite_ratio: workerLines ? Number((postLines / workerLines).toFixed(2)) : null
    });
  }
  return rows.sort((a, b) => b.runs - a.runs || String(a.group).localeCompare(String(b.group)));
}

/** Render groupMetrics rows as a tab-separated table. */
export function formatGroupTable(rows, by) {
  const cols = ["runs", "assessed", "accepted", "minor_rework", "major_rework", "failed", "accepted_pct",
    "verified_accepted", "median_worker_min", "measured_runs", "worker_lines", "post_worker_lines", "rewrite_ratio"];
  const lines = [[by, ...cols].join("\t")];
  for (const r of rows) lines.push([r.group, ...cols.map((c) => r[c] ?? "-")].join("\t"));
  return lines.join("\n");
}
