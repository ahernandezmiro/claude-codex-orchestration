#!/usr/bin/env node
// Role-pinned delegation to Codex through the OpenAI codex-plugin-cc companion runtime.
// Extended version: preserves the original policy layer and adds observability/telemetry.
//
// Suggested location:
//   ~/.claude/orchestration/scripts/codex-delegate.mjs
//
// Core usage (backward-compatible):
//   node codex-delegate.mjs run --role <role> --packet <file.yaml> [--cwd <repo>] [--background] [--effort <e>] [--dry-run]
//   node codex-delegate.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--cwd <repo>]
//   node codex-delegate.mjs result [job-id]
//   node codex-delegate.mjs cancel [job-id]
//   node codex-delegate.mjs verify-git <baseline.json>
//   node codex-delegate.mjs which
//
// Added observability commands:
//   node codex-delegate.mjs runs [--json] [--limit <n>] [--role <role>] [--status <status>]
//   node codex-delegate.mjs show <run-id-or-json-path> [--json]
//   node codex-delegate.mjs assess <run-id-or-json-path> --outcome <accepted|minor_rework|major_rework|failed|not_applicable>
//        [--useful <yes|no|mixed>] [--findings <n>] [--accepted-findings <n>] [--rework-rounds <n>] [--notes <text>]
//   node codex-delegate.mjs record-skip --task-id <id> --task-type <type> --reason <text> [--cwd <repo>]
//   node codex-delegate.mjs metrics [--json] [--role <role>] [--since <ISO-date-or-days>]
//   node codex-delegate.mjs collect <run-id-or-json-path> [--wait] [--timeout-ms <ms>]   // finalize a background run
//
// New run options:
//   --reason <why this delegation was selected>
//   --task-type <implementation|test|design_review|investigation|...>
//   --parent <parent/orchestrator task id>
//   --attempt <n>
//   --budget-key <logical budget bucket>
//   --max-attempts <n>    // hard stop for this budget bucket
//
// Notes:
// - Roles still fix model/sandbox/contract; callers cannot override model.
// - Foreground companion output is captured AND mirrored to the terminal.
// - Background jobs are still delegated to the companion. Submission records the companion job id;
//   `collect` later reads `codex-companion result <job> --json` and finalizes the run (status, timing, git guard).
// - No external packages are required.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS_DIR = path.join(KIT_ROOT, "runs");
const TELEMETRY_DIR = path.join(KIT_ROOT, "telemetry");
const EVENTS_FILE = path.join(TELEMETRY_DIR, "events.jsonl");
const SKIPS_FILE = path.join(TELEMETRY_DIR, "routing-skips.jsonl");

const ROLES = {
  "luna-implement": {
    model: "gpt-6-luna", effort: "high", write: true, worker: "GPT-6 Luna",
    roleDoc: "codex/ROLE_LUNA_IMPLEMENT.md", contract: "task",
    required: ["id", "objective", "editable_paths", "acceptance_criteria"]
  },
  "luna-test": {
    model: "gpt-6-luna", effort: "high", write: true, worker: "GPT-6 Luna",
    roleDoc: "codex/ROLE_LUNA_TEST.md", contract: "task",
    required: ["id", "objective", "acceptance_criteria"]
  },
  "sol-implement": {
    model: "gpt-6-sol", effort: "high", write: true, worker: "GPT-6 Sol",
    roleDoc: "codex/ROLE_LUNA_IMPLEMENT.md", contract: "task",
    required: ["id", "objective", "editable_paths", "acceptance_criteria"]
  },
  "astra-review": {
    model: "gpt-6-astra", effort: "high", write: false, worker: "GPT-6 Astra",
    roleDoc: "codex/ROLE_ASTRA_REVIEW.md", contract: "review",
    required: ["id", "requirements", "artifact"],
    // Blind review: anything outside these keys (rationale, reasoning, discussion...) is stripped.
    allowed: ["id", "role", "requirements", "constraints", "context", "artifact", "focus", "out_of_scope"]
  },
  "astra-investigate": {
    model: "gpt-6-astra", effort: "high", write: false, worker: "GPT-6 Astra",
    roleDoc: "codex/ROLE_ASTRA_INVESTIGATE.md", contract: "result",
    required: ["id", "objective"]
  }
};

const VALID_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const VALID_OUTCOMES = ["accepted", "minor_rework", "major_rework", "failed", "not_applicable"];
const VALID_USEFULNESS = ["yes", "no", "mixed"];

function ensureDirs() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
}

function fail(message, code = 2) {
  console.error(`codex-delegate: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (["background", "dry-run", "json", "wait", "all"].includes(key)) {
      options[key] = true;
    } else {
      if (i + 1 >= argv.length) fail(`missing value for --${key}`);
      options[key] = argv[++i];
    }
  }
  return { options, positionals };
}

function readKitFile(relPath) {
  return fs.readFileSync(path.join(KIT_ROOT, relPath), "utf8").trim();
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function appendJsonl(file, value) {
  ensureDirs();
  fs.appendFileSync(file, JSON.stringify(value) + "\n");
}

function nowIso() {
  return new Date().toISOString();
}

function section(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return "";
  const level = heading.match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").trim();
}

// Locate codex-companion.mjs from the installed OpenAI codex-plugin-cc.
function findCompanion() {
  if (process.env.CODEX_COMPANION && fs.existsSync(process.env.CODEX_COMPANION)) {
    return process.env.CODEX_COMPANION;
  }
  const candidates = [];
  const pushIfPlugin = (pluginDir) => {
    const manifest = path.join(pluginDir, ".claude-plugin", "plugin.json");
    const script = path.join(pluginDir, "scripts", "codex-companion.mjs");
    try {
      if (JSON.parse(fs.readFileSync(manifest, "utf8")).name === "codex" && fs.existsSync(script)) {
        candidates.push({ script, mtime: fs.statSync(script).mtimeMs });
      }
    } catch { /* not a codex plugin */ }
  };
  const subdirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
    } catch { return []; }
  };
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  // Claude desktop remote-managed plugins: local-agent-mode-sessions/<org>/<account>/rpm/<plugin>
  for (const org of subdirs(path.join(appData, "Claude", "local-agent-mode-sessions"))) {
    for (const account of subdirs(org)) {
      for (const plugin of subdirs(path.join(account, "rpm"))) pushIfPlugin(plugin);
    }
  }
  // Claude Code CLI marketplace installs: ~/.claude/plugins/cache/<marketplace>/codex/<version>
  for (const marketplace of subdirs(path.join(os.homedir(), ".claude", "plugins", "cache"))) {
    for (const version of subdirs(path.join(marketplace, "codex"))) pushIfPlugin(version);
  }
  if (candidates.length === 0) {
    fail("codex-companion.mjs not found. Is the OpenAI 'codex' plugin installed? Set CODEX_COMPANION to override.");
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].script;
}

// Split a packet into top-level YAML keys without a YAML dependency.
// Intentionally preserves the original lightweight parser. If packet syntax becomes richer,
// switch to a real YAML parser rather than extending this ad-hoc parser indefinitely.
function splitTopLevel(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*):(.*)$/);
    if (m) {
      current = { key: m[1], lines: [line] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return blocks.map((b) => ({ key: b.key, text: b.lines.join("\n").trimEnd() }));
}

function packetScalar(blocks, key) {
  const block = blocks.find((b) => b.key === key);
  if (!block) return null;
  return block.text.replace(new RegExp(`^${key}:\\s*`), "").trim().replace(/^['\"]|['\"]$/g, "") || null;
}

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  // trimEnd, not trim: porcelain lines start with a meaningful space (" M file").
  return r.status === 0 ? r.stdout.trimEnd() : null;
}

function gitSnapshot(cwd) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return null;
  return {
    root,
    head: git(root, ["rev-parse", "-q", "--verify", "HEAD"]),
    branch: git(root, ["symbolic-ref", "-q", "--short", "HEAD"]),
    refs: git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    remotes: git(root, ["remote", "-v"]),
    stashes: git(root, ["stash", "list"]),
    porcelain: git(root, ["status", "--porcelain=v1"])
  };
}

function porcelainFiles(output) {
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim());
}

function gitChangedFiles(cwd) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return [];
  return porcelainFiles(git(root, ["status", "--porcelain=v1"]));
}

function verifyGit(baseline, { quiet = false } = {}) {
  if (!baseline) {
    if (!quiet) console.log("GIT GUARD: n/a (not a git repository)");
    return { ok: true, changed: [], now: null };
  }
  const now = gitSnapshot(baseline.root);
  const changed = ["head", "branch", "refs", "remotes", "stashes"].filter((k) => (now?.[k] ?? null) !== baseline[k]);
  if (changed.length === 0) {
    if (!quiet) console.log("GIT GUARD: OK (no commits, branch, ref, remote or stash changes)");
    return { ok: true, changed, now };
  }
  if (!quiet) {
    console.log(`GIT GUARD: VIOLATION — worker changed git state: ${changed.join(", ")}`);
    for (const k of changed) {
      console.log(`  ${k}:\n    before: ${JSON.stringify(baseline[k])}\n    after:  ${JSON.stringify(now?.[k] ?? null)}`);
    }
  }
  return { ok: false, changed, now };
}

function buildPrompt(roleName, role, packetText) {
  const agents = readKitFile("codex/AGENTS.md");
  const parts = [
    `You are ${role.worker}, acting in the \`${roleName}\` role of a multi-model orchestration.`,
    "Claude Opus is the orchestrator and owns final decisions. You are subordinate to the task packet below.",
    section(agents, "## Global safety / scope rules"),
    "Git is off-limits beyond read-only inspection: never run git commit, push, merge, rebase, reset, checkout of other branches, tag, stash, remote, or any history rewrite. The orchestrator verifies git state after you finish.",
    readKitFile(role.roleDoc)
  ];
  if (role.contract === "task") {
    const contract = readKitFile("shared/TASK_CONTRACT.md");
    parts.push(section(contract, "## Rules"), section(contract, "## Completion report"));
  } else if (role.contract === "review") {
    parts.push(readKitFile("shared/REVIEW_CONTRACT.md"), readKitFile("shared/CREATIVE_PIPELINE_RULES.md"));
  } else {
    parts.push(readKitFile("codex/RESULT_CONTRACT.md"));
  }
  parts.push(
    "## Task packet",
    "```yaml\n" + packetText.trim() + "\n```",
    "Finish with the YAML report required by your contract as the last thing in your reply."
  );
  return parts.filter(Boolean).join("\n\n") + "\n";
}

function mirror(text, stream = process.stdout) {
  if (text) stream.write(text);
}

// Capture output for telemetry while preserving terminal visibility.
function runCompanionCaptured(args) {
  const companion = findCompanion();
  const startedAt = Date.now();
  const r = spawnSync(process.execPath, ["--no-deprecation", companion, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  mirror(r.stdout || "", process.stdout);
  mirror(r.stderr || "", process.stderr);
  return {
    status: r.status ?? 1,
    signal: r.signal ?? null,
    error: r.error ? String(r.error.message || r.error) : null,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    durationMs: Date.now() - startedAt,
    companion
  };
}

function sanitizeId(s) {
  return String(s || "task").replace(/[^\w.-]+/g, "_");
}

function runIdFromBase(base) {
  return path.basename(base);
}

function runJsonPath(base) {
  return `${base}.run.json`;
}

function appendEvent(type, run) {
  appendJsonl(EVENTS_FILE, {
    ts: nowIso(),
    type,
    run_id: run.run_id,
    task_id: run.task_id,
    parent: run.parent ?? null,
    role: run.role,
    model: run.model,
    task_type: run.task_type ?? null,
    status: run.status,
    outcome: run.assessment?.outcome ?? null,
    useful: run.assessment?.useful ?? null
  });
}

function saveRun(run, type = "run_updated") {
  ensureDirs();
  writeJson(run.run_file, run);
  appendEvent(type, run);
}

function resolveRunFile(input) {
  if (!input) fail("run id or path is required");
  const direct = path.resolve(input);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (fs.existsSync(`${direct}.run.json`)) return `${direct}.run.json`;

  ensureDirs();
  const exact = path.join(RUNS_DIR, input.endsWith(".run.json") ? input : `${input}.run.json`);
  if (fs.existsSync(exact)) return exact;

  const matches = fs.readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".run.json") && (f.includes(input) || f.replace(/\.run\.json$/, "") === input))
    .map((f) => path.join(RUNS_DIR, f));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) fail(`ambiguous run reference '${input}': ${matches.map((m) => path.basename(m)).join(", ")}`);
  fail(`run not found: ${input}`);
}

function loadRun(input) {
  const file = resolveRunFile(input);
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  run.run_file = file;
  return run;
}

function readAllRuns() {
  ensureDirs();
  return fs.readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".run.json"))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf8")); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
}

function parseSince(value) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Date.now() - Number(value) * 24 * 60 * 60 * 1000;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) fail("--since must be an ISO date or an integer number of days");
  return ms;
}

function enforceBudget({ options, taskId, roleName }) {
  const max = options["max-attempts"] ? Number(options["max-attempts"]) : null;
  if (max == null) return;
  if (!Number.isInteger(max) || max < 1) fail("--max-attempts must be an integer >= 1");
  const budgetKey = options["budget-key"] || `${taskId}:${roleName}`;
  const prior = readAllRuns().filter((r) => r.budget_key === budgetKey && !["dry_run", "cancelled"].includes(r.status));
  if (prior.length >= max) {
    fail(`orchestration budget exceeded for '${budgetKey}': ${prior.length}/${max} attempts already recorded`, 4);
  }
}

function cmdRun(options) {
  const roleName = options.role;
  const role = ROLES[roleName];
  if (!role) fail(`--role must be one of: ${Object.keys(ROLES).join(", ")}`);
  if (!options.packet) fail("--packet <file> is required");
  const packetPath = path.resolve(options.packet);
  if (!fs.existsSync(packetPath)) fail(`packet not found: ${packetPath}`);
  const cwd = path.resolve(options.cwd || process.cwd());
  if (!fs.existsSync(cwd)) fail(`--cwd does not exist: ${cwd}`);
  const effort = options.effort || role.effort;
  if (!VALID_EFFORTS.includes(effort)) fail(`--effort must be one of: ${VALID_EFFORTS.join(", ")}`);

  let blocks = splitTopLevel(fs.readFileSync(packetPath, "utf8"));
  const missing = role.required.filter((k) => !blocks.some((b) => b.key === k));
  if (missing.length) fail(`packet is missing required keys for ${roleName}: ${missing.join(", ")}`);

  const originalKeys = blocks.map((b) => b.key);
  let strippedKeys = [];
  if (role.allowed) {
    strippedKeys = blocks.filter((b) => !role.allowed.includes(b.key)).map((b) => b.key);
    if (strippedKeys.length) console.log(`BLIND REVIEW: stripped non-allowed packet keys: ${strippedKeys.join(", ")}`);
    blocks = blocks.filter((b) => role.allowed.includes(b.key));
  }
  const packetText = blocks.map((b) => b.text).join("\n");

  ensureDirs();
  const taskIdRaw = packetScalar(blocks, "id") || "task";
  const taskId = sanitizeId(taskIdRaw);
  enforceBudget({ options, taskId, roleName });

  const stamp = nowIso().replace(/[:.]/g, "-");
  const base = path.join(RUNS_DIR, `${stamp}-${taskId}-${roleName}`);
  const promptFile = `${base}.prompt.md`;
  const stdoutFile = `${base}.stdout.txt`;
  const stderrFile = `${base}.stderr.txt`;
  const baselineFile = `${base}.git-baseline.json`;
  const runFile = runJsonPath(base);
  fs.writeFileSync(promptFile, buildPrompt(roleName, role, packetText));

  const baseline = gitSnapshot(cwd);
  writeJson(baselineFile, baseline);

  const args = ["task", "--cwd", cwd, "--model", role.model, "--effort", effort, "--prompt-file", promptFile, "--fresh"];
  if (role.write) args.push("--write");
  if (options.background) args.push("--background");

  const startedAt = nowIso();
  const run = {
    schema_version: 1,
    run_id: runIdFromBase(base),
    run_file: runFile,
    task_id: taskIdRaw,
    task_type: options["task-type"] || packetScalar(blocks, "role") || role.contract,
    parent: options.parent || null,
    role: roleName,
    worker: role.worker,
    model: role.model,
    effort,
    sandbox: role.write ? "workspace-write" : "read-only",
    cwd,
    packet_file: packetPath,
    packet_keys_original: originalKeys,
    packet_keys_sent: blocks.map((b) => b.key),
    blind_review_stripped_keys: strippedKeys,
    prompt_file: promptFile,
    stdout_file: stdoutFile,
    stderr_file: stderrFile,
    git_baseline_file: baselineFile,
    reason: options.reason || null,
    budget_key: options["budget-key"] || `${taskId}:${roleName}`,
    attempt: options.attempt ? Number(options.attempt) : null,
    max_attempts: options["max-attempts"] ? Number(options["max-attempts"]) : null,
    background: Boolean(options.background),
    started_at: startedAt,
    finished_at: null,
    duration_ms: null,
    companion_path: null,
    companion_status: null,
    companion_signal: null,
    companion_error: null,
    status: options["dry-run"] ? "dry_run" : "running",
    job_id: null,
    git_guard: null,
    dirty_before: porcelainFiles(baseline?.porcelain),
    changed_files_after: [],
    assessment: null
  };
  saveRun(run, "run_started");

  console.log(`DELEGATE: run=${run.run_id}`);
  console.log(`DELEGATE: role=${roleName} model=${role.model} effort=${effort} sandbox=${run.sandbox} cwd=${cwd}`);
  if (run.reason) console.log(`DELEGATE: reason=${run.reason}`);
  console.log(`DELEGATE: prompt=${promptFile}`);

  if (options["dry-run"]) {
    console.log(`DRY RUN: node <codex-companion> ${args.join(" ")}`);
    console.log(`DRY RUN: companion=${findCompanion()}`);
    run.companion_path = findCompanion();
    run.finished_at = nowIso();
    run.duration_ms = 0;
    saveRun(run, "run_finished");
    return 0;
  }

  if (options.background) {
    const result = runCompanionCaptured(args);
    run.job_id = (result.stdout.match(/\b(task-[a-z0-9]+-[a-z0-9]+)\b/i) || [])[1] || null;
    run.companion_path = result.companion;
    run.companion_status = result.status;
    run.companion_signal = result.signal;
    run.companion_error = result.error;
    run.duration_ms = result.durationMs;
    run.finished_at = nowIso();
    run.status = result.status === 0 ? "submitted_background" : "submission_failed";
    saveRun(run, "run_submitted_background");
    console.log(`GIT GUARD: baseline saved. When the job finishes, finalize the run (result + git guard + telemetry):\n  node ~/.claude/orchestration/scripts/codex-delegate.mjs collect ${run.run_id} --wait`);
    console.log(`TELEMETRY: ${runFile}`);
    return result.status;
  }

  const result = runCompanionCaptured(args);
  fs.writeFileSync(stdoutFile, result.stdout);
  fs.writeFileSync(stderrFile, result.stderr);

  const guard = verifyGit(baseline);
  run.companion_path = result.companion;
  run.companion_status = result.status;
  run.companion_signal = result.signal;
  run.companion_error = result.error;
  run.duration_ms = result.durationMs;
  run.finished_at = nowIso();
  run.git_guard = { ok: guard.ok, changed: guard.changed };
  run.changed_files_after = gitChangedFiles(cwd);
  run.status = !guard.ok ? "git_guard_violation" : (result.status === 0 ? "completed" : "failed");
  saveRun(run, "run_finished");

  console.log(`TELEMETRY: ${runFile}`);
  if (!guard.ok) return 3;
  return result.status;
}

// Finalize a background run from the companion's machine-readable job record.
function cmdCollect(options, positionals) {
  if (!positionals[0]) fail("collect <run-id-or-json-path> [--wait] [--timeout-ms <ms>]");
  const run = loadRun(positionals[0]);
  if (!run.background) fail(`run ${run.run_id} is not a background run; foreground runs are finalized automatically`);
  if (!run.job_id) fail(`run ${run.run_id} has no recorded companion job id (submitted with an older wrapper?)`);
  const companion = findCompanion();
  const capture = (args) => spawnSync(process.execPath, ["--no-deprecation", companion, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (options.wait) {
    capture(["status", run.job_id, "--cwd", run.cwd, "--wait", "--json",
      ...(options["timeout-ms"] ? ["--timeout-ms", options["timeout-ms"]] : [])]);
  }
  const r = capture(["result", run.job_id, "--cwd", run.cwd, "--json"]);
  let payload;
  try { payload = JSON.parse(r.stdout); } catch { fail(`could not parse companion result for ${run.job_id}:\n${r.stdout}${r.stderr}`); }
  const job = payload.storedJob || payload.job || {};
  if (!["completed", "failed", "cancelled"].includes(job.status)) {
    console.log(`COLLECT: job ${run.job_id} is ${job.status || "unknown"} (phase ${job.phase || "?"}); not finalized. Re-run with --wait.`);
    return 0;
  }
  const output = job.result?.rawOutput ?? job.rendered ?? "";
  fs.writeFileSync(run.stdout_file, output);
  mirror(output.endsWith("\n") ? output : `${output}\n`);

  const baseline = JSON.parse(fs.readFileSync(run.git_baseline_file, "utf8"));
  const guard = verifyGit(baseline);
  run.git_guard = { ok: guard.ok, changed: guard.changed };
  run.changed_files_after = gitChangedFiles(run.cwd);
  run.touched_files = job.result?.touchedFiles ?? [];
  run.companion_status = job.result?.status ?? null;
  run.job_started_at = job.startedAt ?? null;
  run.finished_at = job.completedAt ?? nowIso();
  if (job.startedAt && job.completedAt) run.duration_ms = Date.parse(job.completedAt) - Date.parse(job.startedAt);
  run.status = !guard.ok ? "git_guard_violation"
    : job.status === "cancelled" ? "cancelled"
    : (job.status === "completed" && (job.result?.status ?? 0) === 0) ? "completed" : "failed";
  saveRun(run, "run_collected");
  console.log(`TELEMETRY: ${run.run_file}`);
  return guard.ok ? 0 : 3;
}

function cmdPassThrough(command, options, positionals) {
  const args = [
    command,
    ...positionals,
    ...(options.cwd ? ["--cwd", options.cwd] : []),
    ...(options.wait ? ["--wait"] : []),
    ...(options.all ? ["--all"] : []),
    ...(options["timeout-ms"] ? ["--timeout-ms", options["timeout-ms"]] : [])
  ];
  // Capture when practical so result/status output can be retained by terminal/session logs.
  const result = runCompanionCaptured(args);
  return result.status;
}

function cmdRuns(options) {
  let runs = readAllRuns();
  if (options.role) runs = runs.filter((r) => r.role === options.role);
  if (options.status) runs = runs.filter((r) => r.status === options.status);
  const limit = options.limit ? Number(options.limit) : 25;
  if (!Number.isInteger(limit) || limit < 1) fail("--limit must be an integer >= 1");
  runs = runs.slice(0, limit);
  if (options.json) {
    console.log(JSON.stringify(runs, null, 2));
    return 0;
  }
  if (!runs.length) {
    console.log("No runs found.");
    return 0;
  }
  console.log("started_at\trole\tmodel\tstatus\toutcome\tuseful\ttask_id\trun_id");
  for (const r of runs) {
    console.log([
      r.started_at || "-", r.role || "-", r.model || "-", r.status || "-",
      r.assessment?.outcome || "-", r.assessment?.useful || "-", r.task_id || "-", r.run_id || "-"
    ].join("\t"));
  }
  return 0;
}

function cmdShow(options, positionals) {
  if (!positionals[0]) fail("show <run-id-or-json-path>");
  const run = loadRun(positionals[0]);
  if (options.json) {
    console.log(JSON.stringify(run, null, 2));
    return 0;
  }
  const summary = {
    run_id: run.run_id,
    task_id: run.task_id,
    parent: run.parent,
    role: run.role,
    model: run.model,
    effort: run.effort,
    reason: run.reason,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    duration_ms: run.duration_ms,
    git_guard: run.git_guard,
    changed_files_after: run.changed_files_after,
    assessment: run.assessment,
    prompt_file: run.prompt_file,
    stdout_file: run.stdout_file,
    stderr_file: run.stderr_file
  };
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

function cmdAssess(options, positionals) {
  if (!positionals[0]) fail("assess <run-id-or-json-path> --outcome <...>");
  if (!options.outcome || !VALID_OUTCOMES.includes(options.outcome)) {
    fail(`--outcome must be one of: ${VALID_OUTCOMES.join(", ")}`);
  }
  if (options.useful && !VALID_USEFULNESS.includes(options.useful)) {
    fail(`--useful must be one of: ${VALID_USEFULNESS.join(", ")}`);
  }
  const numeric = (key) => options[key] == null ? null : Number(options[key]);
  for (const key of ["findings", "accepted-findings", "rework-rounds"]) {
    const v = numeric(key);
    if (v != null && (!Number.isInteger(v) || v < 0)) fail(`--${key} must be an integer >= 0`);
  }
  const run = loadRun(positionals[0]);
  run.assessment = {
    assessed_at: nowIso(),
    outcome: options.outcome,
    useful: options.useful || null,
    findings: numeric("findings"),
    accepted_findings: numeric("accepted-findings"),
    rework_rounds: numeric("rework-rounds"),
    notes: options.notes || null
  };
  saveRun(run, "run_assessed");
  console.log(`ASSESSED: ${run.run_id}`);
  console.log(JSON.stringify(run.assessment, null, 2));
  return 0;
}

function cmdRecordSkip(options) {
  if (!options["task-id"]) fail("record-skip requires --task-id <id>");
  if (!options.reason) fail("record-skip requires --reason <text>");
  const record = {
    ts: nowIso(),
    task_id: options["task-id"],
    task_type: options["task-type"] || null,
    cwd: path.resolve(options.cwd || process.cwd()),
    reason: options.reason,
    expected_role: options.role || null,
    parent: options.parent || null
  };
  appendJsonl(SKIPS_FILE, record);
  appendJsonl(EVENTS_FILE, { ...record, type: "routing_skip" });
  console.log(`ROUTING SKIP RECORDED: ${record.task_id} — ${record.reason}`);
  return 0;
}

function pct(n, d) {
  return d ? Number(((n / d) * 100).toFixed(1)) : 0;
}

function cmdMetrics(options) {
  let runs = readAllRuns();
  if (options.role) runs = runs.filter((r) => r.role === options.role);
  const sinceMs = parseSince(options.since);
  if (sinceMs != null) runs = runs.filter((r) => Date.parse(r.started_at || 0) >= sinceMs);

  const completed = runs.filter((r) => ["completed", "git_guard_violation", "failed"].includes(r.status));
  const assessed = runs.filter((r) => r.assessment);
  const successful = assessed.filter((r) => r.assessment.outcome === "accepted");
  const minor = assessed.filter((r) => r.assessment.outcome === "minor_rework");
  const major = assessed.filter((r) => r.assessment.outcome === "major_rework");
  const failed = assessed.filter((r) => r.assessment.outcome === "failed");
  const useful = assessed.filter((r) => r.assessment.useful === "yes");
  const notUseful = assessed.filter((r) => r.assessment.useful === "no");
  const reviewRuns = assessed.filter((r) => r.role === "astra-review");
  const reviewNoop = reviewRuns.filter((r) => (r.assessment.findings ?? 0) === 0 || r.assessment.useful === "no");
  const reviewFindings = reviewRuns.reduce((s, r) => s + (r.assessment.findings ?? 0), 0);
  const acceptedFindings = reviewRuns.reduce((s, r) => s + (r.assessment.accepted_findings ?? 0), 0);
  const totalDuration = completed.reduce((s, r) => s + (r.duration_ms || 0), 0);

  const byRole = {};
  for (const r of runs) {
    const k = r.role || "unknown";
    byRole[k] ||= { runs: 0, assessed: 0, accepted: 0, useful_yes: 0, duration_ms: 0 };
    byRole[k].runs++;
    byRole[k].duration_ms += r.duration_ms || 0;
    if (r.assessment) {
      byRole[k].assessed++;
      if (r.assessment.outcome === "accepted") byRole[k].accepted++;
      if (r.assessment.useful === "yes") byRole[k].useful_yes++;
    }
  }
  for (const v of Object.values(byRole)) {
    v.accepted_pct = pct(v.accepted, v.assessed);
    v.useful_pct = pct(v.useful_yes, v.assessed);
    v.avg_duration_ms = v.runs ? Math.round(v.duration_ms / v.runs) : 0;
  }

  const metrics = {
    window: { since: options.since || null },
    runs_total: runs.length,
    completed_total: completed.length,
    assessed_total: assessed.length,
    assessment_coverage_pct: pct(assessed.length, runs.length),
    outcomes: {
      accepted: successful.length,
      minor_rework: minor.length,
      major_rework: major.length,
      failed: failed.length,
      first_pass_acceptance_pct: pct(successful.length, assessed.length),
      material_rework_pct: pct(major.length + failed.length, assessed.length)
    },
    usefulness: {
      yes: useful.length,
      no: notUseful.length,
      useful_pct: pct(useful.length, assessed.length)
    },
    astra_review: {
      assessed_reviews: reviewRuns.length,
      no_op_reviews: reviewNoop.length,
      no_op_pct: pct(reviewNoop.length, reviewRuns.length),
      findings_total: reviewFindings,
      accepted_findings_total: acceptedFindings,
      finding_acceptance_pct: pct(acceptedFindings, reviewFindings)
    },
    timing: {
      total_duration_ms: totalDuration,
      avg_completed_duration_ms: completed.length ? Math.round(totalDuration / completed.length) : 0
    },
    by_role: byRole
  };

  if (options.json) {
    console.log(JSON.stringify(metrics, null, 2));
    return 0;
  }
  console.log(JSON.stringify(metrics, null, 2));
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
const { options, positionals } = parseArgs(rest);

switch (command) {
  case "run":
    process.exit(cmdRun(options));
  case "status":
  case "result":
  case "cancel":
    process.exit(cmdPassThrough(command, options, positionals));
  case "verify-git": {
    if (!positionals[0]) fail("verify-git <baseline.json>");
    const baseline = JSON.parse(fs.readFileSync(positionals[0], "utf8"));
    const guard = verifyGit(baseline);
    process.exit(guard.ok ? 0 : 3);
  }
  case "which":
    console.log(findCompanion());
    process.exit(0);
  case "runs":
    process.exit(cmdRuns(options));
  case "show":
    process.exit(cmdShow(options, positionals));
  case "assess":
    process.exit(cmdAssess(options, positionals));
  case "record-skip":
    process.exit(cmdRecordSkip(options));
  case "metrics":
    process.exit(cmdMetrics(options));
  case "collect":
    process.exit(cmdCollect(options, positionals));
  default:
    fail([
      "usage:",
      "  run --role <role> --packet <file> [--cwd <dir>] [--background] [--effort <e>] [--reason <text>] [--task-type <type>] [--parent <id>] [--attempt <n>] [--budget-key <key>] [--max-attempts <n>] [--dry-run]",
      "  status|result|cancel [job-id] [--cwd <dir>] [--wait] [--timeout-ms <ms>]",
      "  verify-git <baseline.json>",
      "  which",
      "  runs [--json] [--limit <n>] [--role <role>] [--status <status>]",
      "  show <run-id-or-json-path> [--json]",
      "  assess <run-id-or-json-path> --outcome <accepted|minor_rework|major_rework|failed|not_applicable> [--useful <yes|no|mixed>] [--findings <n>] [--accepted-findings <n>] [--rework-rounds <n>] [--notes <text>]",
      "  record-skip --task-id <id> --reason <text> [--task-type <type>] [--role <expected-role>] [--parent <id>] [--cwd <dir>]",
      "  metrics [--json] [--role <role>] [--since <ISO-date-or-days>]",
      "  collect <run-id-or-json-path> [--wait] [--timeout-ms <ms>]"
    ].join("\n"));
}
