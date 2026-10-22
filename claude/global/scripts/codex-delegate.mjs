#!/usr/bin/env node
// Role-pinned delegation to Codex through the OpenAI codex-plugin-cc companion runtime.
// Extended version: preserves the original policy layer and adds observability/telemetry.
//
// Suggested location:
//   ~/.claude/orchestration/scripts/codex-delegate.mjs
//
// Core usage (backward-compatible):
//   node codex-delegate.mjs run --role <role> --packet <file.yaml> [--cwd <repo>] [--background] [--effort <e>] [--dry-run] [--worktree] [--base <ref>]
//   node codex-delegate.mjs worktree-apply <run-id> | worktree-clean <run-id> [--force]
//   node codex-delegate.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--cwd <repo>]
//   node codex-delegate.mjs result [job-id]
//   node codex-delegate.mjs cancel [job-id]
//   node codex-delegate.mjs verify-git <baseline.json>
//   node codex-delegate.mjs which
//   node codex-delegate.mjs models [--json]   // effective model/effort per role and the config files used
//   node codex-delegate.mjs quota [--role <role>] [--json]   // Codex window usage and quota-gate verdict per role
//
// Quota gate: every non-dry-run `run` first checks config/quota.json against the Codex rate-limit
// window (see quota-gate.mjs) and exits 5 without delegating when quota is insufficient or unknown.
//
// Added observability commands:
//   node codex-delegate.mjs runs [--json] [--limit <n>] [--role <role>] [--status <status>]
//   node codex-delegate.mjs show <run-id-or-json-path> [--json]
//   node codex-delegate.mjs assess <run-id-or-json-path> --outcome <accepted|minor_rework|major_rework|failed|not_applicable>
//        [--useful <yes|no|mixed>] [--findings <n>] [--accepted-findings <n>] [--rework-rounds <n>] [--notes <text>]
//        [--cause <c1,c2>] [--verified <tests,runtime,visual|none>] [--verified-findings <n>] [--critical-findings <n>]
//   node codex-delegate.mjs record-skip --task-id <id> --task-type <type> --reason <text> [--cwd <repo>]
//   node codex-delegate.mjs metrics [--json] [--role <role>] [--since <ISO-date-or-days>] [--by <dimension>] [--runs-dir <dir> [--all]]
//   node codex-delegate.mjs collect <run-id-or-json-path> [--wait] [--timeout-ms <ms>]   // finalize a background run
//   node codex-delegate.mjs abandon <run-id-or-json-path> [--reason <text>]   // close a run that will never finalize
//
// Attribution (schema 2, see telemetry-lib.mjs): every real run snapshots the working tree before
// the worker starts (baseline_tree) and when its result is finalized (worker_tree). The worker's
// files and patch size come from the diff between the two, so dirty trees and foreground runs are
// covered. `assess` diffs worker_tree against the current tree, limited to those files, to measure
// what Opus changed afterwards (post_worker).
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
// - Roles still fix model/sandbox/contract; callers cannot override model. The model and default
//   effort per role come from ../config/models.json (+ optional models.local.json), not this file.
// - Foreground companion output is captured AND mirrored to the terminal.
// - Background jobs are still delegated to the companion. Submission records the companion job id;
//   `collect` later reads `codex-companion result <job> --json` and finalizes the run (status, timing, git guard).
// - No external packages are required.

import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveCodexBin, buildExecArgs, submitJob, readJob, waitJob, cancelJob, reconcileLost, normalizeExecResult } from "./exec-backend.mjs";
import {
  QUOTA_BLOCKED_EXIT_CODE, loadQuotaRules, readQuotaSnapshot, ongoingReservations, evaluateQuotaGate, formatGateLine
} from "./quota-gate.mjs";
import {
  VALID_CAUSES, VALID_VERIFIED, UNFINALIZED_STATUSES, GROUP_KEYS, snapshotTree, changedPaths, diffStat,
  parseWorkerReport, countListItems, looksLikeQuotaStop, overlappingRuns, churn, groupMetrics, formatGroupTable
} from "./telemetry-lib.mjs";

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS_DIR = path.join(KIT_ROOT, "runs");
const TELEMETRY_DIR = path.join(KIT_ROOT, "telemetry");
const EVENTS_FILE = path.join(TELEMETRY_DIR, "events.jsonl");
const SKIPS_FILE = path.join(TELEMETRY_DIR, "routing-skips.jsonl");
// Model and effort per role live in config/, not here, so they can change without touching
// role definitions or prompts. models.local.json (optional, per machine) overrides models.json.
const MODEL_CONFIG_FILES = [
  path.join(KIT_ROOT, "config", "models.json"),
  path.join(KIT_ROOT, "config", "models.local.json")
];
const QUOTA_CONFIG_FILE = path.join(KIT_ROOT, "config", "quota.json");

const ROLES = {
  "luna-implement": {
    write: true, defaultPrompt: "implement.md", contract: "task",
    required: ["id", "objective", "editable_paths", "acceptance_criteria"]
  },
  "luna-test": {
    write: true, defaultPrompt: "luna-test.md", contract: "task",
    required: ["id", "objective", "acceptance_criteria"]
  },
  "sol-implement": {
    write: true, defaultPrompt: "implement.md", contract: "task",
    required: ["id", "objective", "editable_paths", "acceptance_criteria"]
  },
  "astra-review": {
    write: false, defaultPrompt: "astra-review.md", contract: "review",
    required: ["id", "requirements", "artifact"],
    // Blind review: anything outside these keys (rationale, reasoning, discussion...) is stripped.
    allowed: ["id", "role", "requirements", "constraints", "context", "artifact", "focus", "out_of_scope"]
  },
  "astra-investigate": {
    write: false, defaultPrompt: "astra-investigate.md", contract: "result",
    required: ["id", "objective"]
  }
};

const VALID_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const VALID_OUTCOMES = ["accepted", "minor_rework", "major_rework", "failed", "not_applicable"];
const VALID_USEFULNESS = ["yes", "no", "mixed"];

/**
 * Resolve the model and default effort for every role from config/models.json, with
 * config/models.local.json overriding individual fields when present.
 * Input: none (reads MODEL_CONFIG_FILES).
 * Output: { selection: { <role>: { model, effort } }, sources: [files read] }.
 * Fails (exit 2) on a missing base file, invalid JSON, unknown role, or a role left
 * without a model or with an invalid effort — never falls back to a stale default.
 */
function loadModelSelection() {
  const [baseFile] = MODEL_CONFIG_FILES;
  if (!fs.existsSync(baseFile)) fail(`model config not found: ${baseFile} (re-run the deploy script)`);
  const selection = Object.fromEntries(Object.keys(ROLES).map((name) => [name, {}]));
  const sources = [];
  for (const file of MODEL_CONFIG_FILES.filter((f) => fs.existsSync(f))) {
    let config;
    try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { fail(`invalid JSON in ${file}: ${e.message}`); }
    for (const [roleName, values] of Object.entries(config.roles ?? {})) {
      if (!ROLES[roleName]) fail(`${file}: unknown role '${roleName}' (roles: ${Object.keys(ROLES).join(", ")})`);
      for (const key of ["model", "effort"]) {
        if (values?.[key] != null) selection[roleName][key] = values[key];
      }
    }
    sources.push(file);
  }
  for (const [roleName, { model, effort }] of Object.entries(selection)) {
    if (!model || typeof model !== "string") fail(`no model configured for role '${roleName}' in ${sources.join(" + ")}`);
    if (!VALID_EFFORTS.includes(effort)) fail(`role '${roleName}' effort must be one of: ${VALID_EFFORTS.join(", ")} (got ${JSON.stringify(effort)})`);
  }
  return { selection, sources };
}

/**
 * Find and validate the nearest project defaults file without crossing the repository root.
 * Input: original run cwd. Output: null or { file, sha256, config }.
 */
function findProjectConfig(startDir) {
  const start = path.resolve(startDir);
  const rootValue = git(start, ["rev-parse", "--show-toplevel"]);
  const root = rootValue ? path.resolve(rootValue) : start;
  let dir = start;
  let file = null;
  while (true) {
    const candidate = path.join(dir, ".orchestration", "project.json");
    if (fs.existsSync(candidate)) { file = candidate; break; }
    if (dir === root || dir === path.dirname(dir)) break;
    dir = path.dirname(dir);
  }
  if (!file) return null;
  let config;
  const bytes = fs.readFileSync(file);
  try { config = JSON.parse(bytes.toString("utf8")); }
  catch (e) { fail(`invalid project config ${file}: ${e.message}`); }
  const problem = (message) => fail(`invalid project config ${file}: ${message}`);
  if (!config || Array.isArray(config) || typeof config !== "object") problem("expected a JSON object");
  const known = new Set(["schema_version", "constraints", "required_checks", "context", "roles", "review_safe"]);
  for (const key of Object.keys(config)) if (!known.has(key)) problem(`unknown key '${key}'`);
  if (config.schema_version !== 1) problem("schema_version must be 1");
  for (const key of ["constraints", "required_checks"]) {
    if (Object.hasOwn(config, key) && (!Array.isArray(config[key]) || config[key].some((item) => typeof item !== "string")))
      problem(`${key} must be an array of strings`);
  }
  if (Object.hasOwn(config, "context") && typeof config.context !== "string") problem("context must be a string");
  if (Object.hasOwn(config, "review_safe") && typeof config.review_safe !== "boolean") problem("review_safe must be a boolean");
  if (Object.hasOwn(config, "roles") && (!config.roles || Array.isArray(config.roles) || typeof config.roles !== "object")) problem("roles must be an object");
  for (const [roleName, values] of Object.entries(config.roles || {})) {
    if (!Object.hasOwn(ROLES, roleName)) problem(`unknown role '${roleName}'`);
    if (!values || Array.isArray(values) || typeof values !== "object") problem(`roles.${roleName} must be an object`);
    for (const key of Object.keys(values)) if (!["model", "effort"].includes(key)) problem(`roles.${roleName} has unknown key '${key}'`);
    if (Object.hasOwn(values, "model") && (typeof values.model !== "string" || !values.model.trim())) problem(`roles.${roleName}.model must be a non-empty string`);
    if (Object.hasOwn(values, "effort") && !VALID_EFFORTS.includes(values.effort)) problem(`roles.${roleName}.effort must be one of: ${VALID_EFFORTS.join(", ")}`);
  }
  return { file, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), config };
}

/**
 * Resolve the role-specific prompt from the nearest project override, kit override,
 * or the role's kit default. Project discovery has the same boundary as project.json.
 */
function findRolePrompt(startDir, roleName) {
  const role = ROLES[roleName];
  if (!role) fail(`unknown role '${roleName}'`);
  const ignored = [];
  const warnings = [];
  const knownFiles = new Set(Object.keys(ROLES).map((name) => `${name}.md`));
  const start = path.resolve(startDir);
  const rootValue = git(start, ["rev-parse", "--show-toplevel"]);
  const root = rootValue ? path.resolve(rootValue) : start;
  const dirs = [];
  let dir = start;
  while (true) {
    dirs.push(dir);
    if (dir === root || dir === path.dirname(dir)) break;
    dir = path.dirname(dir);
  }

  const inspectRolesDir = (rolesDir) => {
    if (!fs.existsSync(rolesDir)) return;
    let entries;
    try { entries = fs.readdirSync(rolesDir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const entryPath = path.join(rolesDir, entry.name);
      if (entry.name.endsWith(".md") && !knownFiles.has(entry.name)) {
        warnings.push(`ROLE PROMPT: ignoring unknown role file ${entryPath}`);
      } else if (!entry.isFile()) {
        warnings.push(`ROLE PROMPT: ignoring non-file role entry ${entryPath}`);
      }
    }
  };
  const readPrompt = (file, source) => {
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    if (!stat.isFile()) {
      warnings.push(`ROLE PROMPT: ignoring non-file role entry ${file}`);
      return null;
    }
    let text;
    try { text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim(); }
    catch (error) { fail(`cannot read role prompt ${file}: ${error.message}`); }
    const byteLength = Buffer.byteLength(text, "utf8");
    if (!text) fail(`role prompt is empty: ${file}`);
    if (byteLength > 65536) fail(`role prompt exceeds 65536 bytes: ${file}`);
    return { source, path: file, text, sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"), ignored, warnings };
  };

  for (const projectDir of dirs) {
    const orchestrationDir = path.join(projectDir, ".orchestration");
    const rolesDir = path.join(orchestrationDir, "roles");
    inspectRolesDir(rolesDir);
    const file = path.join(rolesDir, `${roleName}.md`);
    if (!fs.existsSync(file)) continue;
    if (!fs.statSync(file).isFile()) continue;
    if (roleName.startsWith("astra-")) {
      const reviewConfig = path.join(orchestrationDir, "project.json");
      let reviewSafe = false;
      if (fs.existsSync(reviewConfig)) {
        try { reviewSafe = JSON.parse(fs.readFileSync(reviewConfig, "utf8")).review_safe === true; }
        catch { /* findProjectConfig validates project.json separately when applicable */ }
      }
      if (!reviewSafe) {
        ignored.push({ path: file, reason: "no review_safe: true next to it" });
        warnings.push(`ROLE PROMPT: project override for ${roleName} ignored (no review_safe: true next to it)`);
        continue;
      }
    }
    const result = readPrompt(file, "project");
    if (result) return result;
  }

  const globalDir = path.join(KIT_ROOT, "overrides", "roles");
  inspectRolesDir(globalDir);
  const globalFile = path.join(globalDir, `${roleName}.md`);
  // inspectRolesDir already warned about a non-file entry here; do not warn twice.
  const global = fs.existsSync(globalFile) && fs.statSync(globalFile).isFile() ? readPrompt(globalFile, "global") : null;
  if (global) return global;
  const defaultFile = path.join(KIT_ROOT, "codex", "prompts", "roles", role.defaultPrompt);
  const fallback = readPrompt(defaultFile, "default");
  if (!fallback) fail(`default role prompt not found: ${defaultFile}`);
  return fallback;
}

/**
 * Add project constraints, checks and context to parsed packet blocks.
 * Input: splitTopLevel blocks, validated config, role name. Output: { blocks, applied }.
 */
function applyProjectDefaults(blocks, project, roleName) {
  const applied = { constraints: 0, required_checks: 0, context: false };
  if (!project) return { blocks, applied };
  const config = project.config;
  const astra = roleName.startsWith("astra-");
  const next = [...blocks];
  if (!astra) {
    for (const key of ["constraints", "required_checks"]) {
      const items = config[key] || [];
      if (!items.length) continue;
      const index = next.findIndex((block) => block.key === key);
      if (index < 0) next.push({ key, text: `${key}:\n${items.map((item) => `  - ${JSON.stringify(item)}`).join("\n")}` });
      else {
        const lines = next[index].text.split(/\r?\n/);
        const itemLines = lines.slice(1).filter((line) => line.trim() && !line.trim().startsWith("#"));
        // YAML allows list items at column 0 or indented; reuse the packet's own indentation.
        const indent = itemLines[0]?.match(/^(\s*)- /)?.[1] ?? "  ";
        if (lines[0].trimEnd() !== `${key}:` || itemLines.some((line) => !line.startsWith(`${indent}- `) && !line.startsWith(`${indent}  `)))
          fail(`packet ${key} must be a block list to receive project defaults`);
        next[index] = { key, text: `${next[index].text}\n${items.map((item) => `${indent}- ${JSON.stringify(item)}`).join("\n")}` };
      }
      applied[key] = items.length;
    }
    if (config.context) {
      next.push({ key: "project_context", text: `project_context: |\n${config.context.split(/\r?\n/).map((line) => `  ${line}`).join("\n")}` });
      applied.context = true;
    }
  } else if (config.review_safe === true && config.context) {
    next.push({ key: "project_context", text: `project_context: |\n${config.context.split(/\r?\n/).map((line) => `  ${line}`).join("\n")}` });
    applied.context = true;
  }
  return { blocks: next, applied };
}

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
    if (["background", "dry-run", "json", "wait", "all", "worktree", "force"].includes(key)) {
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

// Locate codex-companion.mjs from the installed OpenAI codex-plugin-cc.
function findCompanion({ quiet = false } = {}) {
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
  // Newer desktop layout: Claude/rpm/<org>/<account>/<plugin>
  for (const org of subdirs(path.join(appData, "Claude", "rpm"))) {
    for (const account of subdirs(org)) {
      for (const plugin of subdirs(account)) pushIfPlugin(plugin);
    }
  }
  // Claude Code CLI marketplace installs: ~/.claude/plugins/cache/<marketplace>/codex/<version>
  for (const marketplace of subdirs(path.join(os.homedir(), ".claude", "plugins", "cache"))) {
    for (const version of subdirs(path.join(marketplace, "codex"))) pushIfPlugin(version);
  }
  if (candidates.length === 0) {
    if (quiet) return null;
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

function gitInput(cwd, args, input) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function gitSnapshot(cwd) {
  const resolvedRoot = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!resolvedRoot) return null;
  const root = path.resolve(resolvedRoot);
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

function verifyGit(baseline, { quiet = false, worktree = null } = {}) {
  if (!baseline) {
    if (!quiet) console.log("GIT GUARD: n/a (not a git repository)");
    return { ok: true, changed: [], now: null };
  }
  const now = gitSnapshot(baseline.root);
  let changed;
  if (worktree) {
    const branchRef = `refs/heads/${worktree.branch}`;
    const relevantRefs = (value) => (value || "").split(/\r?\n/).filter(Boolean)
      .filter((line) => !line.startsWith("refs/heads/") || line.startsWith(`${branchRef} `)).join("\n");
    changed = ["head", "branch", "remotes", "stashes"].filter((k) => (now?.[k] ?? null) !== baseline[k]);
    if (relevantRefs(now?.refs) !== relevantRefs(baseline.refs)) changed.push("refs");
  } else changed = ["head", "branch", "refs", "remotes", "stashes"].filter((k) => (now?.[k] ?? null) !== baseline[k]);
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

function buildPrompt(roleName, role, packetText, rolePrompt) {
  const parts = [
    readKitFile("codex/prompts/base.md"),
    rolePrompt,
    readKitFile(`codex/prompts/contracts/${role.contract}.md`),
    "## Task packet",
    "```yaml\n" + packetText.trim() + "\n```",
    "Finish with the YAML report above as the last thing in your reply."
  ];
  return parts.join("\n\n") + "\n";
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
  const prior = readAllRuns().filter((r) => r.budget_key === budgetKey && !["dry_run", "cancelled", "abandoned"].includes(r.status));
  if (prior.length >= max) {
    fail(`orchestration budget exceeded for '${budgetKey}': ${prior.length}/${max} attempts already recorded`, 4);
  }
}

/**
 * Quota gate for one role: current window usage minus reservations of ongoing runs.
 * Input: role name. Output: Promise<{ decision, snapshot, ongoing, errors }>.
 * Exits 2 on an invalid config/quota.json (same as a bad model config).
 */
async function checkQuota(roleName) {
  let rules;
  try { rules = loadQuotaRules(QUOTA_CONFIG_FILE, Object.keys(ROLES)); } catch (e) { fail(e.message); }
  const { snapshot, errors } = await readQuotaSnapshot(rules);
  const ongoing = ongoingReservations(readAllRuns(), rules);
  return { decision: evaluateQuotaGate({ role: roleName, snapshot, ongoing, rules }), snapshot, ongoing, errors };
}

/**
 * Apply the quota gate before a real delegation. Blocks with exit code 5 and a
 * `quota_gate_blocked` telemetry event; no run record is created for a blocked call.
 * Input: role name, task id. Output: Promise<gate record to store on the run>.
 */
async function enforceQuota(roleName, taskId) {
  const { decision, snapshot, ongoing, errors } = await checkQuota(roleName);
  for (const e of errors) console.log(`QUOTA GATE: source error — ${e}`);
  console.log(formatGateLine(decision, snapshot, ongoing));
  const record = { ...decision, used_percent: snapshot?.usedPercent ?? null, resets_at: snapshot?.resetsAt ?? null,
    source: snapshot?.source ?? null, ongoing_run_ids: ongoing.map((r) => r.run_id) };
  if (!decision.allowed) {
    appendJsonl(EVENTS_FILE, { ts: nowIso(), type: "quota_gate_blocked", task_id: taskId, role: roleName, quota_gate: record });
    console.log("QUOTA GATE: delegation skipped. Do not retry now; do the work without this worker or wait for the window to reset.");
    process.exit(QUOTA_BLOCKED_EXIT_CODE);
  }
  return record;
}

/**
 * `quota` command: show window usage, ongoing reservations and the gate verdict per role.
 * Input: { role?, json? }. Output: Promise<exit code> — 0 if every listed role is allowed, else 5.
 */
async function cmdQuota(options) {
  const roleNames = options.role ? [options.role] : Object.keys(ROLES);
  if (options.role && !ROLES[options.role]) fail(`--role must be one of: ${Object.keys(ROLES).join(", ")}`);
  let rules;
  try { rules = loadQuotaRules(QUOTA_CONFIG_FILE, Object.keys(ROLES)); } catch (e) { fail(e.message); }
  const { snapshot, errors } = await readQuotaSnapshot(rules);
  const ongoing = ongoingReservations(readAllRuns(), rules);
  const decisions = roleNames.map((role) => evaluateQuotaGate({ role, snapshot, ongoing, rules }));
  if (options.json) {
    console.log(JSON.stringify({ snapshot, errors, ongoing, decisions }, null, 2));
  } else {
    for (const e of errors) console.log(`source error — ${e}`);
    for (const d of decisions) console.log(formatGateLine(d, snapshot, ongoing));
  }
  return decisions.every((d) => d.allowed) ? 0 : QUOTA_BLOCKED_EXIT_CODE;
}

async function cmdRun(options) {
  const roleName = options.role;
  let role = ROLES[roleName];
  if (!role) fail(`--role must be one of: ${Object.keys(ROLES).join(", ")}`);
  if (!options.packet) fail("--packet <file> is required");
  const packetPath = path.resolve(options.packet);
  if (!fs.existsSync(packetPath)) fail(`packet not found: ${packetPath}`);
  let cwd = path.resolve(options.cwd || process.cwd());
  if (!fs.existsSync(cwd)) fail(`--cwd does not exist: ${cwd}`);
  const project = findProjectConfig(cwd);
  const rolePrompt = findRolePrompt(cwd, roleName);
  for (const warning of rolePrompt.warnings) console.log(warning);
  console.log(`ROLE PROMPT: ${rolePrompt.source} ${rolePrompt.path}`);
  const modelSelection = loadModelSelection().selection[roleName];
  const projectRole = project?.config.roles?.[roleName] || {};
  const model = projectRole.model || modelSelection.model;
  const configuredEffort = projectRole.effort || modelSelection.effort;
  const effort = options.effort || configuredEffort;
  const modelSource = projectRole.model ? "project" : "config";
  const effortSource = options.effort ? "cli" : projectRole.effort ? "project" : "config";
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
  const projectApplied = applyProjectDefaults(blocks, project, roleName);
  blocks = projectApplied.blocks;
  if (projectApplied.applied.context && roleName.startsWith("astra-")) {
    // Permit only this generated key for this run; the static blind-review allowlist stays frozen.
    role = { ...role, allowed: [...(role.allowed || []), "project_context"] };
  }
  const packetText = blocks.map((b) => b.text).join("\n");
  const backend = options.backend || process.env.ORCH_BACKEND || "exec";
  if (!["exec", "companion"].includes(backend)) fail(`--backend must be exec or companion (got ${backend})`);
  const codexBin = backend === "exec" ? resolveCodexBin() : null;
  if (codexBin && !codexBin.ok) fail(`codex CLI ${codexBin.reason}: ${codexBin.detail}`);

  ensureDirs();
  const taskIdRaw = packetScalar(blocks, "id") || "task";
  const taskId = sanitizeId(taskIdRaw);
  enforceBudget({ options, taskId, roleName });
  // Dry runs never reach Codex, so they neither need quota nor should depend on a live read.
  const quotaGate = options["dry-run"] ? null : await enforceQuota(roleName, taskIdRaw);

  const stamp = nowIso().replace(/[:.]/g, "-");
  const base = path.join(RUNS_DIR, `${stamp}-${taskId}-${roleName}`);
  const promptFile = `${base}.prompt.md`;
  const stdoutFile = `${base}.stdout.txt`;
  const stderrFile = `${base}.stderr.txt`;
  const baselineFile = `${base}.git-baseline.json`;
  const runFile = runJsonPath(base);
  fs.writeFileSync(promptFile, buildPrompt(roleName, role, packetText, rolePrompt.text));
  const promptSha256 = crypto.createHash("sha256").update(fs.readFileSync(promptFile)).digest("hex");

  let worktree = null;
  if (options.worktree && !options["dry-run"]) {
    const main = git(cwd, ["rev-parse", "--show-toplevel"]);
    if (!main) fail("--worktree requires --cwd inside a git repository");
    const mainRoot = path.resolve(main);
    const dirty = git(mainRoot, ["status", "--porcelain=v1"]) || "";
    const stampWt = nowIso().replace(/[-:TZ.]/g, "").slice(0, 14);
    const suffix = `${taskId}-${stampWt}`;
    const branch = `orch/${suffix}`;
    const wtPath = path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}-wt`, suffix);
    const baseRef = options.base || "HEAD";
    const baseCommit = git(mainRoot, ["rev-parse", `${baseRef}^{commit}`]);
    if (!baseCommit) fail(`could not resolve worktree base '${baseRef}'`);
    const add = gitInput(mainRoot, ["worktree", "add", "-b", branch, wtPath, baseRef]);
    if (add.status !== 0) fail(`could not create worktree: ${add.stderr.trim()}`);
    if (dirty) console.log(`WORKTREE: main checkout has ${dirty.split(/\r?\n/).filter(Boolean).length} uncommitted change(s); the worker starts from ${baseRef} and will not see them.`);
    console.log(`WORKTREE: ${wtPath} (branch ${branch}, base ${baseCommit.slice(0, 8)})`);
    const relative = path.relative(mainRoot, cwd);
    cwd = relative ? path.join(wtPath, relative) : wtPath;
    worktree = { path: wtPath, branch, base: baseRef, base_commit: baseCommit, main_root: mainRoot,
      created_at: nowIso(), applied_at: null, applied_tree: null, pre_apply: null, cleaned_at: null };
  } else if (options.worktree && !git(cwd, ["rev-parse", "--show-toplevel"])) {
    fail("--worktree requires --cwd inside a git repository");
  }
  const baseline = gitSnapshot(cwd);
  // Content snapshot for attribution; dry runs never reach a worker, so they skip the hashing cost.
  if (baseline && !options["dry-run"]) baseline.tree = snapshotTree(baseline.root);
  writeJson(baselineFile, baseline);

  const args = ["task", "--cwd", cwd, "--model", model, "--effort", effort, "--prompt-file", promptFile, "--fresh"];
  if (role.write) args.push("--write");
  if (options.background) args.push("--background");
  const startedAt = nowIso();
  const run = {
    schema_version: 2,
    run_id: runIdFromBase(base),
    run_file: runFile,
    task_id: taskIdRaw,
    task_type: options["task-type"] || packetScalar(blocks, "role") || role.contract,
    parent: options.parent || null,
    role: roleName,
    worker: role.worker,
    model,
    model_source: modelSource,
    effort,
    effort_source: effortSource,
    sandbox: role.write ? "workspace-write" : "read-only",
    cwd,
    packet_file: packetPath,
    packet_keys_original: originalKeys,
    packet_keys_sent: blocks.map((b) => b.key),
    blind_review_stripped_keys: strippedKeys,
    prompt_file: promptFile,
    role_prompt: { source: rolePrompt.source, path: rolePrompt.path, sha256: rolePrompt.sha256 },
    stdout_file: stdoutFile,
    stderr_file: stderrFile,
    git_baseline_file: baselineFile,
    reason: options.reason || null,
    budget_key: options["budget-key"] || `${taskId}:${roleName}`,
    attempt: options.attempt ? Number(options.attempt) : null,
    max_attempts: options["max-attempts"] ? Number(options["max-attempts"]) : null,
    quota_gate: quotaGate,
    background: Boolean(options.background),
    started_at: startedAt,
    finished_at: null,
    duration_ms: null,
    companion_path: null,
    backend,
    exec: backend === "exec" ? { command: codexBin.command, source: codexBin.source, job_dir: `${base}.job`, thread_id: null,
      failures: [], warnings: 0, reasons: [] } : null,
    companion_status: null,
    companion_signal: null,
    companion_error: null,
    status: options["dry-run"] ? "dry_run" : "running",
    job_id: null,
    git_guard: null,
    dirty_before: porcelainFiles(baseline?.porcelain),
    changed_files_after: [],
    git_root: baseline?.root ?? null,
    baseline_tree: baseline?.tree ?? null,
    worker_tree: null,
    touched_files: [],
    touched_files_source: null,
    worker_patch: null,
    required_checks_count: countListItems(blocks.find((b) => b.key === "required_checks")?.text),
    project_config: project ? { file: project.file, sha256: project.sha256, schema_version: 1, applied: {
      ...projectApplied.applied, model: Boolean(projectRole.model), effort: Boolean(projectRole.effort)
    } } : null,
    prompt_sha256: promptSha256,
    worker_report: null,
    failure_hint: null,
    submission_ms: null,
    worker_duration_ms: null,
    collected_at: null,
    assessment: null
  };
  if (worktree) run.worktree = worktree;
  saveRun(run, "run_started");

  console.log(`DELEGATE: run=${run.run_id}`);
  console.log(`DELEGATE: role=${roleName} model=${model} effort=${effort} sandbox=${run.sandbox} cwd=${cwd}`);
  if (run.reason) console.log(`DELEGATE: reason=${run.reason}`);
  console.log(`DELEGATE: prompt=${promptFile}`);
  if (project) {
    const overrides = [projectRole.model && "model", projectRole.effort && "effort"].filter(Boolean).join(", ") || "none";
    console.log(`PROJECT: ${project.file} (+${projectApplied.applied.constraints} constraints, +${projectApplied.applied.required_checks} checks, context ${projectApplied.applied.context ? "yes" : "no"}, overrides: ${overrides})`);
  }

  if (options["dry-run"]) {
    if (backend === "exec") {
      const execArgs = buildExecArgs({ cwd, model, effort, sandbox: run.sandbox, lastMessageFile: path.join(run.exec.job_dir, "last-message.txt") });
      console.log(`DRY RUN: codex ${execArgs.join(" ")}`);
    } else {
      console.log(`DRY RUN: node <codex-companion> ${args.join(" ")}`);
      console.log(`DRY RUN: companion=${findCompanion()}`);
      run.companion_path = findCompanion();
    }
    run.finished_at = nowIso();
    run.duration_ms = 0;
    saveRun(run, "run_finished");
    return 0;
  }

  if (backend === "exec") {
    const jobDir = `${base}.job`;
    const lastMessageFile = path.join(jobDir, "last-message.txt");
    const execArgs = buildExecArgs({ cwd, model, effort, sandbox: run.sandbox, lastMessageFile });
    const submitStarted = Date.now();
    const submitted = await submitJob({ jobDir, command: codexBin.command, prefixArgs: codexBin.prefixArgs, args: execArgs, cwd, promptFile });
    run.submission_ms = Date.now() - submitStarted;
    run.job_id = `exec:${run.run_id}`;
    if (submitted.state.status === "pending") console.log("EXEC: runner start not confirmed; collect will resolve it");
    if (options.background) {
      run.status = "submitted_background";
      saveRun(run, "run_submitted_background");
      console.log(`GIT GUARD: baseline saved. Finalize with collect ${run.run_id} --wait`);
      console.log(`TELEMETRY: ${runFile}`);
      return 0;
    }
    run.status = "running";
    saveRun(run, "run_exec_submitted");
    console.log(`EXEC: job ${jobDir}`);
    const job = await waitJob(jobDir, { timeoutMs: Infinity });
    return await finalizeExecRun(run, job);
  }

  if (options.background) {
    const result = runCompanionCaptured(args);
    run.job_id = (result.stdout.match(/\b(task-[a-z0-9]+-[a-z0-9]+)\b/i) || [])[1] || null;
    run.companion_path = result.companion;
    run.companion_status = result.status;
    run.companion_signal = result.signal;
    run.companion_error = result.error;
    // Submission time only; worker runtime (duration_ms, worker_duration_ms) is set by `collect`.
    run.submission_ms = result.durationMs;
    run.status = result.status === 0 ? "submitted_background" : "submission_failed";
    if (run.status === "submission_failed") run.finished_at = nowIso();
    saveRun(run, "run_submitted_background");
    console.log(`GIT GUARD: baseline saved. When the job finishes, finalize the run (result + git guard + telemetry):\n  node ~/.claude/orchestration/scripts/codex-delegate.mjs collect ${run.run_id} --wait`);
    console.log(`TELEMETRY: ${runFile}`);
    return result.status;
  }

  const result = runCompanionCaptured(args);
  fs.writeFileSync(stdoutFile, result.stdout);
  fs.writeFileSync(stderrFile, result.stderr);

  const guard = verifyGit(baseline, { worktree });
  run.companion_path = result.companion;
  run.companion_status = result.status;
  run.companion_signal = result.signal;
  run.companion_error = result.error;
  run.duration_ms = result.durationMs;
  run.worker_duration_ms = result.durationMs;
  run.finished_at = nowIso();
  run.git_guard = { ok: guard.ok, changed: guard.changed };
  run.changed_files_after = gitChangedFiles(cwd);
  run.status = !guard.ok ? "git_guard_violation" : (result.status === 0 ? "completed" : "failed");
  recordWorkerResult(run, `${result.stdout}\n${result.stderr}`);
  saveRun(run, "run_finished");

  console.log(`TELEMETRY: ${runFile}`);
  if (!guard.ok) return 3;
  return result.status;
}

/**
 * Finalize an exec run from its detached runner record.
 * Input: run record and readJob/waitJob result. Output: Promise<number> status-based exit code.
 */
async function finalizeExecRun(run, job) {
  const jobDir = run.exec.job_dir;
  if (job.state.status === "lost") {
    await reconcileLost(jobDir);
    job = readJob(jobDir);
  }
  if (job.state.status === "pending" && !job.state.runner_pid
      && Date.now() - Date.parse(job.state.submitted_at || 0) > 60000) {
    const stateFile = path.join(jobDir, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.status = "failed";
    state.io_error = "runner never started";
    state.finished_at = nowIso();
    writeJson(stateFile, state);
    job = readJob(jobDir);
  }
  if (!["completed", "failed", "cancelled"].includes(job.state.status)) return 0;
  const events = job.events || { thread_id: null, failures: [], warnings: 0, reasons: [], usage: {} };
  const normalized = normalizeExecResult({ state: job.state, events,
    finalMessageExists: Boolean(job.finalMessage) });
  const message = job.finalMessage ?? "";
  fs.writeFileSync(run.stdout_file, message);
  fs.writeFileSync(run.stderr_file, job.stderrTail || "");
  mirror(message.endsWith("\n") || !message ? message : `${message}\n`);
  const baseline = JSON.parse(fs.readFileSync(run.git_baseline_file, "utf8"));
  const guard = verifyGit(baseline, { worktree: run.worktree });
  run.git_guard = { ok: guard.ok, changed: guard.changed };
  run.changed_files_after = gitChangedFiles(run.cwd);
  recordWorkerResult(run, message);
  run.status = !guard.ok ? "git_guard_violation" : normalized.status;
  if (run.status !== "completed" && run.failure_hint !== "quota") run.failure_hint = normalized.failure_hint;
  run.exec.thread_id = events.thread_id;
  run.exec.failures = events.failures || [];
  run.exec.warnings = events.warnings || 0;
  run.exec.reasons = normalized.reasons || [];
  run.codex_usage = events.usage || {};
  run.finished_at = job.state.finished_at;
  run.collected_at = nowIso();
  const duration = job.state.started_at && job.state.finished_at
    ? Date.parse(job.state.finished_at) - Date.parse(job.state.started_at) : null;
  run.duration_ms = duration;
  run.worker_duration_ms = duration;
  saveRun(run, "run_collected");
  console.log(`TELEMETRY: ${run.run_file}`);
  return !guard.ok ? 3 : run.status === "completed" ? 0 : 1;
}

/**
 * Record what the worker produced, mechanically: content snapshot, touched files, patch size,
 * parsed completion report and a quota-stop hint. Mutates `run`.
 * Input: run (with git_root/baseline_tree when in a repo), worker output text.
 * Falls back to companion-reported files (`reportedFiles`) when no snapshot is possible.
 */
function recordWorkerResult(run, output, reportedFiles = null) {
  if (run.git_root && run.baseline_tree) {
    run.worker_tree = snapshotTree(run.git_root);
    const rel = changedPaths(run.git_root, run.baseline_tree, run.worker_tree);
    run.touched_files = rel.map((f) => path.join(run.git_root, f));
    run.touched_files_source = "git";
    run.worker_patch = diffStat(run.git_root, run.baseline_tree, run.worker_tree);
  } else if (reportedFiles) {
    run.touched_files = reportedFiles;
    run.touched_files_source = "companion";
  }
  if (reportedFiles) run.touched_files_reported = reportedFiles;
  run.worker_report = parseWorkerReport(output);
  if (run.status === "failed" && looksLikeQuotaStop(output)) run.failure_hint = "quota";
}

// Finalize a background run from the companion's machine-readable job record.
function collectExitCode(run) {
  return run.status === "completed" ? 0 : run.status === "git_guard_violation" ? 3 : 1;
}

function alreadyFinalized(run) {
  return Boolean(run.collected_at || (run.git_guard && !["running", "submitted_background"].includes(run.status)));
}

async function withFinalizeLock(run, fn) {
  const lock = `${run.run_file}.lock`;
  try {
    fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    // A lock is live while its owner runs (collect --wait can hold it for a long time); a lock whose
    // owner is gone, or an unreadable one older than 10 minutes, is stale.
    const owner = Number(fs.readFileSync(lock, "utf8").trim());
    let ownerAlive = false;
    if (Number.isInteger(owner) && owner > 0) {
      try { process.kill(owner, 0); ownerAlive = true; } catch (e) { ownerAlive = e.code === "EPERM"; }
    } else {
      ownerAlive = Date.now() - fs.statSync(lock).mtimeMs < 10 * 60 * 1000;
    }
    if (ownerAlive) {
      console.log("COLLECT: another process is finalizing this run");
      return 2;
    }
    fs.rmSync(lock, { force: true });
    fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
  }
  // fail() exits the process, which skips `finally`; release the lock on exit too.
  const release = () => fs.rmSync(lock, { force: true });
  process.once("exit", release);
  try { return await fn(); }
  finally { release(); process.removeListener("exit", release); }
}

function printAlreadyFinalized(run) {
  console.log(`COLLECT: already finalized (${run.status})`);
  try { mirror(fs.readFileSync(run.stdout_file, "utf8")); } catch {}
  return collectExitCode(run);
}

async function cmdCollect(options, positionals) {
  if (!positionals[0]) fail("collect <run-id-or-json-path> [--wait] [--timeout-ms <ms>]");
  const run = loadRun(positionals[0]);
  if (alreadyFinalized(run)) return printAlreadyFinalized(run);
  const locked = withFinalizeLock(run, async () => {
  const latest = loadRun(run.run_file);
  if (alreadyFinalized(latest)) return printAlreadyFinalized(latest);
  if (latest.backend === "exec") {
    const jobDir = latest.exec.job_dir;
    let job = readJob(jobDir);
    if (job.state.status === "lost") {
      await reconcileLost(jobDir);
      job = readJob(jobDir);
    }
    if (! ["completed", "failed", "cancelled"].includes(job.state.status) && options.wait) {
      const timeoutMs = options["timeout-ms"] == null ? Infinity : Number(options["timeout-ms"]);
      job = await waitJob(jobDir, { timeoutMs });
    }
    const stalePending = job.state.status === "pending" && !job.state.runner_pid
      && Date.now() - Date.parse(job.state.submitted_at || 0) > 60000;
    if (stalePending) return finalizeExecRun(latest, job);
    if (!["completed", "failed", "cancelled"].includes(job.state.status)) {
      console.log(`COLLECT: job ${latest.job_id} is ${job.state.status}; not finalized. Re-run with --wait.`);
      return 0;
    }
    return finalizeExecRun(latest, job);
  }
  if (!latest.background) fail(`run ${latest.run_id} is not a background run; foreground runs are finalized automatically`);
  const companionRun = latest;
  if (!companionRun.job_id) fail(`run ${companionRun.run_id} has no recorded companion job id (submitted with an older wrapper?)`);
  const companion = findCompanion();
  const capture = (args) => spawnSync(process.execPath, ["--no-deprecation", companion, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (options.wait) {
    capture(["status", companionRun.job_id, "--cwd", companionRun.cwd, "--wait", "--json",
      ...(options["timeout-ms"] ? ["--timeout-ms", options["timeout-ms"]] : [])]);
  }
  const r = capture(["result", companionRun.job_id, "--cwd", companionRun.cwd, "--json"]);
  let payload;
  try { payload = JSON.parse(r.stdout); } catch { fail(`could not parse companion result for ${companionRun.job_id}:\n${r.stdout}${r.stderr}`); }
  const job = payload.storedJob || payload.job || {};
  if (!["completed", "failed", "cancelled"].includes(job.status)) {
    console.log(`COLLECT: job ${companionRun.job_id} is ${job.status || "unknown"} (phase ${job.phase || "?"}); not finalized. Re-run with --wait.`);
    return 0;
  }
  const output = job.result?.rawOutput ?? job.rendered ?? "";
  fs.writeFileSync(companionRun.stdout_file, output);
  mirror(output.endsWith("\n") ? output : `${output}\n`);

  const baseline = JSON.parse(fs.readFileSync(companionRun.git_baseline_file, "utf8"));
  const guard = verifyGit(baseline, { worktree: companionRun.worktree });
  companionRun.git_guard = { ok: guard.ok, changed: guard.changed };
  companionRun.changed_files_after = gitChangedFiles(companionRun.cwd);
  companionRun.companion_status = job.result?.status ?? null;
  companionRun.job_started_at = job.startedAt ?? null;
  companionRun.finished_at = job.completedAt ?? nowIso();
  companionRun.collected_at = nowIso();
  if (job.startedAt && job.completedAt) {
    companionRun.duration_ms = Date.parse(job.completedAt) - Date.parse(job.startedAt);
    companionRun.worker_duration_ms = companionRun.duration_ms;
  } else {
    companionRun.duration_ms = null;
  }
  companionRun.status = !guard.ok ? "git_guard_violation"
    : job.status === "cancelled" ? "cancelled"
    : (job.status === "completed" && (job.result?.status ?? 0) === 0) ? "completed" : "failed";
  // Records submitted by a schema-1 wrapper have no baseline tree: companion file list only.
  if (!companionRun.baseline_tree && baseline?.tree) companionRun.baseline_tree = baseline.tree;
  if (!companionRun.git_root && baseline?.root) companionRun.git_root = baseline.root;
  recordWorkerResult(companionRun, output, job.result?.touchedFiles ?? []);
  saveRun(companionRun, "run_collected");
  console.log(`TELEMETRY: ${companionRun.run_file}`);
  return guard.ok ? 0 : 3;
  });
  return await locked;
}

async function cmdPassThrough(command, options, positionals) {
  const reference = positionals[0];
  const runRef = reference?.startsWith("exec:") ? reference.slice(5) : reference;
  if (reference && (reference.startsWith("exec:") || fs.existsSync(RUNS_DIR))) {
    const direct = path.resolve(runRef);
    const possibleFiles = [
      direct,
      `${direct}.run.json`,
      path.join(RUNS_DIR, runRef.endsWith(".run.json") ? runRef : `${runRef}.run.json`)
    ];
    let execRun = null;
    for (const file of possibleFiles) {
      try {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          const candidate = JSON.parse(fs.readFileSync(file, "utf8"));
          if (candidate.backend === "exec") { execRun = { ...candidate, run_file: file }; break; }
        }
      } catch { /* unrelated or incomplete run record */ }
    }
    if (!execRun && fs.existsSync(RUNS_DIR)) {
      for (const name of fs.readdirSync(RUNS_DIR).filter((item) => item.endsWith(".run.json") && item.includes(runRef))) {
        const file = path.join(RUNS_DIR, name);
        try {
          const candidate = JSON.parse(fs.readFileSync(file, "utf8"));
          if (candidate.backend === "exec") { execRun = { ...candidate, run_file: file }; break; }
        } catch { /* ignore malformed records */ }
      }
    }
    if (execRun) {
      const jobDir = execRun.exec.job_dir;
      if (command === "status") {
        const job = options.wait ? await waitJob(jobDir, { timeoutMs: options["timeout-ms"] == null ? Infinity : Number(options["timeout-ms"]) }) : readJob(jobDir);
        console.log(`EXEC: ${execRun.job_id} ${job.state.status}`);
        return 0;
      }
      if (command === "result") {
        const job = readJob(jobDir);
        console.log(job.finalMessage ?? "not finished");
        return 0;
      }
      if (command === "cancel") {
        const result = await cancelJob(jobDir);
        if (result.ok) {
          const job = readJob(jobDir);
          await finalizeExecRun(execRun, job);
          console.log("CANCELLED");
          return 0;
        }
        if (["completed", "failed", "cancelled"].includes(result.status)) {
          console.log(`CANCEL: run already ${result.status}`);
          return 2;
        }
        console.error(`CANCEL: ${result.detail || `could not stop run (${result.status})`}`);
        return 1;
      }
    }
  }
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
  const unfinalized = runs.filter((r) => UNFINALIZED_STATUSES.includes(r.status));
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
  if (unfinalized.length) {
    console.log(`\n${unfinalized.length} run(s) not finalized (running/submitted_background). Use collect, or abandon for orphans:`);
    for (const r of unfinalized) console.log(`  ${r.status}\t${r.run_id}`);
  }
  return 0;
}

/**
 * Explain effective per-role settings and project packet additions without delegating.
 * Input: role positional, optional --cwd and --json. Output: exit code, with no quota check.
 */
function cmdConfigExplain(options, positionals) {
  const roleName = positionals[0];
  if (!roleName || !ROLES[roleName]) fail(`config --explain <role> [--cwd <dir>] [--json]; role must be one of: ${Object.keys(ROLES).join(", ")}`);
  const cwd = path.resolve(options.cwd || process.cwd());
  if (!fs.existsSync(cwd)) fail(`--cwd does not exist: ${cwd}`);
  const project = findProjectConfig(cwd);
  const rolePrompt = findRolePrompt(cwd, roleName);
  const configured = loadModelSelection().selection[roleName];
  const projectRole = project?.config.roles?.[roleName] || {};
  const result = {
    role: roleName,
    model: projectRole.model || configured.model,
    model_source: projectRole.model ? "project" : "config",
    effort: projectRole.effort || configured.effort,
    effort_source: projectRole.effort ? "project" : "config",
    project_file: project?.file || "none",
    constraints: roleName.startsWith("astra-") ? [] : (project?.config.constraints || []),
    required_checks: roleName.startsWith("astra-") ? [] : (project?.config.required_checks || []),
    context: project && project.config.context && (!roleName.startsWith("astra-") || project.config.review_safe === true)
      ? project.config.context : null,
    review_safe_applies: roleName.startsWith("astra-") ? project?.config.review_safe === true : null,
    role_prompt: { source: rolePrompt.source, path: rolePrompt.path, ignored: rolePrompt.ignored }
  };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`role: ${result.role}`);
    console.log(`model: ${result.model} (source: ${result.model_source})`);
    console.log(`effort: ${result.effort} (source: ${result.effort_source})`);
    console.log(`project file: ${result.project_file}`);
    console.log(`constraints: ${JSON.stringify(result.constraints)}`);
    console.log(`required_checks: ${JSON.stringify(result.required_checks)}`);
    console.log(`context: ${result.context == null ? "none" : JSON.stringify(result.context)}`);
    if (result.review_safe_applies != null) console.log(`review_safe applies: ${result.review_safe_applies ? "yes" : "no"}`);
    console.log(`ROLE PROMPT: ${rolePrompt.source} ${rolePrompt.path}`);
    for (const warning of rolePrompt.warnings) console.log(warning);
    if (rolePrompt.ignored.length) console.log(`role prompt ignored: ${JSON.stringify(rolePrompt.ignored)}`);
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
    backend: run.backend ?? "companion",
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
    worker_duration_ms: run.worker_duration_ms,
    collected_at: run.collected_at,
    git_guard: run.git_guard,
    changed_files_after: run.changed_files_after,
    touched_files: run.touched_files,
    touched_files_source: run.touched_files_source,
    worker_patch: run.worker_patch,
    worker_report: run.worker_report,
    required_checks_count: run.required_checks_count,
    failure_hint: run.failure_hint,
    codex_usage: run.codex_usage,
    exec: run.exec,
    assessment: run.assessment,
    post_worker: run.post_worker,
    worktree: run.worktree,
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
  for (const key of ["findings", "accepted-findings", "rework-rounds", "verified-findings", "critical-findings"]) {
    const v = numeric(key);
    if (v != null && (!Number.isInteger(v) || v < 0)) fail(`--${key} must be an integer >= 0`);
  }
  for (const key of ["accepted-findings", "verified-findings", "critical-findings"]) {
    if (numeric(key) != null && numeric("findings") != null && numeric(key) > numeric("findings")) {
      fail(`--${key} cannot exceed --findings`);
    }
  }
  const list = (key, valid) => {
    if (options[key] == null) return [];
    const values = String(options[key]).split(",").map((s) => s.trim()).filter(Boolean);
    const bad = values.filter((v) => !valid.includes(v));
    if (bad.length) fail(`--${key} values must be from: ${valid.join(", ")} (got ${bad.join(", ")})`);
    return [...new Set(values)];
  };
  const cause = list("cause", VALID_CAUSES);
  const verified = list("verified", VALID_VERIFIED);
  if (verified.includes("none") && verified.length > 1) fail("--verified none cannot be combined with other values");

  const run = loadRun(positionals[0]);
  const assessedAt = nowIso();
  if (UNFINALIZED_STATUSES.includes(run.status)) {
    console.log(`ASSESS WARNING: run is still '${run.status}'. Finalize it first (collect for background runs, abandon for orphans); worker timing and files are not recorded yet.`);
  }
  run.assessment = {
    assessed_at: assessedAt,
    outcome: options.outcome,
    useful: options.useful || null,
    findings: numeric("findings"),
    accepted_findings: numeric("accepted-findings"),
    verified_findings: numeric("verified-findings"),
    critical_findings: numeric("critical-findings"),
    rework_rounds: numeric("rework-rounds"),
    cause,
    verified,
    status_at_assessment: run.status,
    notes: options.notes || null
  };
  run.post_worker = measurePostWorker(run, assessedAt);
  saveRun(run, "run_assessed");
  console.log(`ASSESSED: ${run.run_id}`);
  console.log(JSON.stringify(run.assessment, null, 2));
  if (run.post_worker?.measured) {
    const p = run.post_worker;
    console.log(`REWRITE: worker ${churn(run.worker_patch)} lines in ${run.worker_patch?.files ?? 0} files; `
      + `changed afterwards ${churn(p)} lines in ${p.files} files (ratio ${p.rewrite_ratio ?? "-"}, attribution ${p.attribution})`);
  } else if (run.post_worker) {
    console.log(`REWRITE: not measured (${run.post_worker.reason})`);
  }
  return 0;
}

/**
 * Measure what changed in the worker's files after its result was recorded: diff worker_tree
 * against the current working tree, limited to touched files. Re-assessing re-measures.
 * Input: run, assessment time. Output: post_worker record ({ measured: false, reason } when n/a).
 */
function measurePostWorker(run, assessedAt) {
  if (run.role?.startsWith("astra")) return null;
  if (!run.worker_tree || !run.git_root) {
    return { measured: false, reason: run.schema_version >= 2 ? "no worker snapshot (run not finalized or not a git repo)" : "record predates schema 2" };
  }
  if (!fs.existsSync(run.git_root)) return { measured: false, reason: `repo not found: ${run.git_root}` };
  if (run.worktree) {
    const wt = run.worktree;
    if (!fs.existsSync(wt.main_root) || !fs.existsSync(wt.path)) return { measured: false, reason: "worktree or main checkout not found" };
    const files = (run.touched_files || []).map((f) => path.relative(run.git_root, f).split(path.sep).join("/"));
    if (wt.applied_at) {
      const nowTree = snapshotTree(wt.main_root);
      const after = diffStat(wt.main_root, wt.applied_tree, nowTree, files);
      if (!after) return { measured: false, reason: "git diff failed" };
      // Field-wise sum intentionally permits a file touched before and after apply to count twice.
      const stat = Object.fromEntries(["files", "lines_added", "lines_removed", "binary_files"]
        .map((key) => [key, (wt.pre_apply?.[key] || 0) + (after[key] || 0)]));
      const overlapping = overlappingRuns(run, readAllRuns(), assessedAt);
      const workerLines = churn(run.worker_patch);
      return { measured: true, measured_at: assessedAt, current_tree: nowTree, ...stat,
        rewrite_ratio: workerLines ? Number((churn(stat) / workerLines).toFixed(2)) : null,
        overlapping_runs: overlapping, attribution: overlapping.length ? "uncertain" : "clean" };
    }
  }
  const nowTree = snapshotTree(run.git_root);
  const files = (run.touched_files || []).map((f) => path.relative(run.git_root, f).split(path.sep).join("/"));
  const stat = diffStat(run.git_root, run.worker_tree, nowTree, files);
  if (!stat) return { measured: false, reason: "git diff failed" };
  const overlapping = overlappingRuns(run, readAllRuns(), assessedAt);
  const workerLines = churn(run.worker_patch);
  return {
    measured: true,
    measured_at: assessedAt,
    current_tree: nowTree,
    ...stat,
    rewrite_ratio: workerLines ? Number((churn(stat) / workerLines).toFixed(2)) : null,
    overlapping_runs: overlapping,
    // Changes by another worker in the same files can't be told apart from Opus's corrections.
    attribution: overlapping.length ? "uncertain" : "clean"
  };
}

/** Apply or discard a recorded worker worktree. Input: command, run id, options. Output: exit code. */
function cmdWorktree(command, options, positionals) {
  if (!positionals[0]) fail(`${command} <run-id> ${command === "worktree-clean" ? "[--force]" : ""}`);
  const run = loadRun(positionals[0]);
  const wt = run.worktree;
  if (!wt) fail(`run ${run.run_id} has no worktree`);
  if (command === "worktree-apply") {
    if (wt.applied_at) fail(`run ${run.run_id} worktree is already applied`);
    if (UNFINALIZED_STATUSES.includes(run.status)) fail(`run ${run.run_id} is not finalized`);
    if (!fs.existsSync(wt.path) || !fs.existsSync(wt.main_root)) fail("worktree or main checkout not found");
    const current = snapshotTree(wt.path);
    const files = (run.touched_files || []).map((f) => path.relative(wt.path, f).split(path.sep).join("/"));
    const pre = diffStat(wt.path, run.worker_tree, current, files);
    const patch = gitInput(wt.path, ["diff", "--binary", run.baseline_tree, current]);
    if (patch.status !== 0) fail(patch.stderr.trim(), 1);
    const applied = gitInput(wt.main_root, ["apply", "--whitespace=nowarn"], patch.stdout);
    if (applied.status !== 0) { process.stderr.write(applied.stderr); return 1; }
    wt.pre_apply = pre;
    wt.applied_at = nowIso();
    wt.applied_tree = snapshotTree(wt.main_root);
    saveRun(run, "run_worktree_applied");
    // Count the files in the patch itself; the main tree may hold unrelated uncommitted changes.
    const appliedFiles = changedPaths(wt.path, run.baseline_tree, current).length;
    console.log(`APPLIED: ${appliedFiles} file(s) into ${wt.main_root}`);
    return 0;
  }
  if (wt.cleaned_at) fail(`run ${run.run_id} worktree is already cleaned`);
  const dirty = git(wt.path, ["status", "--porcelain=v1"]) || "";
  const head = git(wt.path, ["rev-parse", "HEAD"]);
  const unmerged = head && git(wt.main_root, ["rev-list", "--count", `${wt.base_commit}..${head}`]);
  if (!options.force && ((dirty && !wt.applied_at) || Number(unmerged) > 0)) fail("refusing to remove unapplied worktree changes or commits; use --force");
  // Once applied, the recorded tree is already in the main checkout, so remove the residual worker tree.
  const remove = gitInput(wt.main_root, ["worktree", "remove", ...(options.force || wt.applied_at ? ["--force"] : []), wt.path]);
  if (remove.status !== 0) fail(remove.stderr.trim(), 1);
  const branch = gitInput(wt.main_root, ["branch", "-D", wt.branch]);
  if (branch.status !== 0) fail(branch.stderr.trim(), 1);
  wt.cleaned_at = nowIso();
  saveRun(run, "run_worktree_cleaned");
  console.log(`CLEANED: ${wt.path}`);
  return 0;
}

function cmdAbandon(options, positionals) {
  if (!positionals[0]) fail("abandon <run-id-or-json-path> [--reason <text>]");
  const run = loadRun(positionals[0]);
  if (!UNFINALIZED_STATUSES.includes(run.status)) fail(`run ${run.run_id} is '${run.status}'; only running or submitted_background runs can be abandoned`);
  run.status = "abandoned";
  run.finished_at = nowIso();
  run.abandoned_reason = options.reason || null;
  saveRun(run, "run_abandoned");
  console.log(`ABANDONED: ${run.run_id} (no longer reserves quota or counts against its budget)`);
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

// Run records under a directory tree, e.g. an extracted telemetry pack (all hosts, recursively).
// Validation runs (runs/_validation) are skipped unless includeValidation is set.
function readRunsFrom(dir, includeValidation = false) {
  if (!fs.existsSync(dir)) fail(`--runs-dir not found: ${dir}`);
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (includeValidation || e.name !== "_validation") walk(p); }
      else if (e.name.endsWith(".run.json")) {
        try { out.push(JSON.parse(fs.readFileSync(p, "utf8"))); } catch { /* skip unreadable record */ }
      }
    }
  };
  walk(dir);
  // The same run can appear in several packs or host folders; keep one per run id.
  return [...new Map(out.map((r) => [r.run_id, r])).values()];
}

function cmdMetrics(options) {
  let runs = options["runs-dir"] ? readRunsFrom(path.resolve(options["runs-dir"]), options.all) : readAllRuns();
  runs = runs.filter((r) => r.status !== "dry_run");
  if (options.role) runs = runs.filter((r) => r.role === options.role);
  const sinceMs = parseSince(options.since);
  if (sinceMs != null) runs = runs.filter((r) => Date.parse(r.started_at || 0) >= sinceMs);
  if (options.by) {
    if (!GROUP_KEYS.includes(options.by)) fail(`--by must be one of: ${GROUP_KEYS.join(", ")}`);
    const rows = groupMetrics(runs, options.by);
    console.log(options.json ? JSON.stringify(rows, null, 2) : formatGroupTable(rows, options.by));
    return 0;
  }

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
  const measured = assessed.filter((r) => r.worker_patch && r.post_worker?.measured);

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
    codex_usage: runs.reduce((totals, run) => {
      for (const key of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"])
        totals[key] += Number(run.codex_usage?.[key]) || 0;
      return totals;
    }, { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 }),
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
    attribution: {
      unfinalized_runs: runs.filter((r) => UNFINALIZED_STATUSES.includes(r.status)).length,
      verified_accepted: successful.filter((r) => (r.assessment.verified || []).some((v) => v !== "none")).length,
      causes: Object.fromEntries(VALID_CAUSES.map((c) => [c, assessed.filter((r) => (r.assessment.cause || []).includes(c)).length])),
      rewrite_measured_runs: measured.length,
      worker_lines_total: measured.reduce((s, r) => s + churn(r.worker_patch), 0),
      post_worker_lines_total: measured.reduce((s, r) => s + churn(r.post_worker), 0),
      worker_report_checks_executed: runs.filter((r) => r.worker_report?.checks_executed).length,
      worker_report_missing: runs.filter((r) => r.schema_version >= 2 && !r.role?.startsWith("astra")
        && !UNFINALIZED_STATUSES.includes(r.status) && !r.worker_report).length
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
    process.exit(await cmdRun(options));
  case "quota":
    process.exit(await cmdQuota(options));
  case "status":
  case "result":
  case "cancel":
    process.exit(await cmdPassThrough(command, options, positionals));
  case "verify-git": {
    if (!positionals[0]) fail("verify-git <baseline.json>");
    const baseline = JSON.parse(fs.readFileSync(positionals[0], "utf8"));
    const guard = verifyGit(baseline);
    process.exit(guard.ok ? 0 : 3);
  }
  case "which":
    {
      const bin = resolveCodexBin();
      const companion = findCompanion({ quiet: true });
      console.log(bin.ok ? `codex: ${bin.command} (${bin.source})` : `codex: not found (${bin.reason}: ${bin.detail})`);
      console.log(companion ? `companion: ${companion}` : "companion: not found");
      process.exit(bin.ok || companion ? 0 : 2);
    }
  case "models": {
    const { selection, sources } = loadModelSelection();
    if (options.json) console.log(JSON.stringify({ sources, roles: selection }, null, 2));
    else {
      console.log(`config: ${sources.join(" + ")}`);
      for (const [roleName, { model, effort }] of Object.entries(selection)) console.log(`${roleName}\t${model}\t${effort}`);
    }
    process.exit(0);
  }
  case "config":
    if (!options.explain) fail("config --explain <role> [--cwd <dir>] [--json]");
    process.exit(cmdConfigExplain(options, [options.explain, ...positionals]));
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
    process.exit(await cmdCollect(options, positionals));
  case "abandon":
    process.exit(cmdAbandon(options, positionals));
  case "worktree-apply":
  case "worktree-clean":
    process.exit(cmdWorktree(command, options, positionals));
  default:
    fail([
      "usage:",
      "  run --role <role> --packet <file> [--cwd <dir>] [--background] [--effort <e>] [--reason <text>] [--task-type <type>] [--parent <id>] [--attempt <n>] [--budget-key <key>] [--max-attempts <n>] [--dry-run] [--worktree] [--base <ref>]",
      "  status|result|cancel [job-id] [--cwd <dir>] [--wait] [--timeout-ms <ms>]",
      "  verify-git <baseline.json>",
      "  which",
      "  models [--json]",
      "  config --explain <role> [--cwd <dir>] [--json]",
      "  quota [--role <role>] [--json]",
      "  runs [--json] [--limit <n>] [--role <role>] [--status <status>]",
      "  show <run-id-or-json-path> [--json]",
      "  assess <run-id-or-json-path> --outcome <accepted|minor_rework|major_rework|failed|not_applicable> [--useful <yes|no|mixed>] [--findings <n>] [--accepted-findings <n>] [--rework-rounds <n>] [--notes <text>]",
      `      [--cause <${VALID_CAUSES.join("|")},...>] [--verified <tests,runtime,visual|none>] [--verified-findings <n>] [--critical-findings <n>]`,
      "  record-skip --task-id <id> --reason <text> [--task-type <type>] [--role <expected-role>] [--parent <id>] [--cwd <dir>]",
      `  metrics [--json] [--role <role>] [--since <ISO-date-or-days>] [--by <${GROUP_KEYS.join("|")}>] [--runs-dir <dir> [--all]]`,
      "  collect <run-id-or-json-path> [--wait] [--timeout-ms <ms>]",
      "  abandon <run-id-or-json-path> [--reason <text>]",
      "  worktree-apply <run-id>",
      "  worktree-clean <run-id> [--force]",
    ].join("\n"));
}
