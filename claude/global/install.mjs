#!/usr/bin/env node
// Installs the Claude-side orchestration setup into ~/.claude (idempotent).
//
//   node claude/global/install.mjs --check       preflight only, changes nothing
//   node claude/global/install.mjs --dry-run     show what would change
//   node claude/global/install.mjs               install / update
//   node claude/global/install.mjs --uninstall   remove installed files, preserving runs/, telemetry/ and overrides/
//   node claude/global/install.mjs --uninstall --purge   also delete runs/, telemetry/ and overrides/
//
// Install and update are the same operation: the managed folders under ~/.claude/orchestration
// (MANAGED_DIRS) are deleted and re-copied from the kit, so files removed from the kit disappear
// too. runs/, telemetry/ and overrides/ are user data. Normally invoked through deploy.ps1 / deploy.sh
// at the repo root, which add the Node version and prompt-freeze checks.
//
// See claude/GLOBAL_INSTALL.md for the manual, step-by-step equivalent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveCodexBin } from "./scripts/exec-backend.mjs";
import { upsertBlock, removeBlock, ManagedBlockError } from "./scripts/managed-block.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, "..", "..");
const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const DEST = path.join(CLAUDE_HOME, "orchestration");
const AGENTS_DIR = path.join(CLAUDE_HOME, "agents");
const CLAUDE_MD = path.join(CLAUDE_HOME, "CLAUDE.md");
const SETTINGS = path.join(CLAUDE_HOME, "settings.json");
const AGENT_FILES = ["luna-worker.md", "astra-reviewer.md"];
// The managed kit directories under DEST; runs/, telemetry/ and overrides/ are user data and excluded.
const MANAGED_DIRS = ["shared", "codex", "claude", "scripts", "templates", "config"];

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

function act(description, fn) {
  console.log(`${DRY ? "[dry-run] " : ""}${description}`);
  if (!DRY) fn();
}

function copyDir(src, dst, filter = () => true) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!filter(entry)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function backup(file) {
  if (fs.existsSync(file)) {
    const target = `${file}.bak-${stamp}`;
    fs.copyFileSync(file, target);
    console.log(`  backup: ${target}`);
  }
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", shell: process.platform === "win32" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function preflight() {
  console.log("Preflight:");
  let ok = true;
  const check = (label, pass, detail) => {
    console.log(`  [${pass ? "ok" : "!!"}] ${label}${detail ? ` — ${detail}` : ""}`);
    if (!pass) ok = false;
  };
  const major = Number(process.versions.node.split(".")[0]);
  check("node >= 18", major >= 18, process.version);
  const codexBin = resolveCodexBin();
  check("codex CLI", codexBin.ok, codexBin.ok ? `${codexBin.command} (${codexBin.source})` : `${codexBin.reason}: ${codexBin.detail}`);
  const login = codexBin.ok ? spawnSync(codexBin.command, [...codexBin.prefixArgs, "login", "status"], { encoding: "utf8", shell: false }) : null;
  const loginOut = login ? `${login.stdout ?? ""}${login.stderr ?? ""}` : "Codex CLI unavailable";
  check("codex logged in", Boolean(login && login.status === 0 && /logged in/i.test(loginOut)), loginOut.trim().split("\n").pop());
  const cache = path.join(os.homedir(), ".codex", "models_cache.json");
  let slugs = [];
  try {
    const data = JSON.parse(fs.readFileSync(cache, "utf8"));
    slugs = (data.models ?? data).map((m) => m.slug);
  } catch { /* cache missing until Codex has run once */ }
  for (const model of configuredModels(check)) {
    check(`model id ${model}`, slugs.includes(model), slugs.length ? "" : "models_cache.json not readable; run codex once");
  }
  const wrapper = path.join(HERE, "scripts", "codex-delegate.mjs");
  const which = spawnSync(process.execPath, [wrapper, "which"], { encoding: "utf8" });
  const companionFound = which.status === 0 && !/companion: not found/.test(which.stdout || "");
  console.log(`  [info] companion ${companionFound ? "installed" : "not installed (only needed for --backend companion)"}`);
  const mcp = run("codex", ["mcp-server", "--help"]);
  console.log(`  [info] codex mcp-server ${/Usage: codex(.exe)? mcp-server/i.test(mcp.out) ? "available (codex-dispatch plugin usable)" : "not available (codex-dispatch plugin unusable)"}`);
  return ok;
}

/**
 * List the distinct model ids the kit's config selects, using the kit's own wrapper so the
 * models.json + models.local.json merge rules live in one place.
 * Input: the preflight `check` reporter (used to flag an invalid config).
 * Output: array of model id strings (empty when the config is invalid).
 */
function configuredModels(check) {
  const wrapper = path.join(HERE, "scripts", "codex-delegate.mjs");
  const r = spawnSync(process.execPath, [wrapper, "models", "--json"], { encoding: "utf8" });
  check("model config (config/models.json + models.local.json)", r.status === 0, (r.status === 0 ? "" : r.stderr || r.stdout).trim());
  if (r.status !== 0) return [];
  return [...new Set(Object.values(JSON.parse(r.stdout).roles).map((role) => role.model))];
}

function install() {
  // Plan the CLAUDE.md change first: malformed markers must stop the install before anything is touched.
  const current = fs.existsSync(CLAUDE_MD) ? fs.readFileSync(CLAUDE_MD, "utf8") : "";
  const claudeMd = upsertBlock(current, "claude-md", "@~/.claude/orchestration/claude/CLAUDE.orchestration.md");
  act(`remove previously installed kit files -> ${DEST}/{${MANAGED_DIRS.join(",")}} (runs/, telemetry/ and overrides/ kept)`, () => {
    for (const dir of MANAGED_DIRS) fs.rmSync(path.join(DEST, dir), { recursive: true, force: true });
  });
  act(`copy kit docs -> ${DEST}/{shared,codex,claude}`, () => {
    copyDir(path.join(KIT, "shared"), path.join(DEST, "shared"));
    copyDir(path.join(KIT, "codex"), path.join(DEST, "codex"));
    copyDir(path.join(KIT, "claude"), path.join(DEST, "claude"), (e) => e.isFile() && e.name.endsWith(".md"));
    fs.copyFileSync(path.join(HERE, "CLAUDE.orchestration.md"), path.join(DEST, "claude", "CLAUDE.orchestration.md"));
  });
  act(`copy wrapper + templates + model config -> ${DEST}/{scripts,templates,config}`, () => {
    copyDir(path.join(HERE, "scripts"), path.join(DEST, "scripts"));
    copyDir(path.join(HERE, "templates"), path.join(DEST, "templates"));
    // models.local.json is copied only when this machine's checkout has one (it is gitignored).
    copyDir(path.join(HERE, "config"), path.join(DEST, "config"), (e) => e.isFile() && e.name.endsWith(".json"));
    fs.mkdirSync(path.join(DEST, "runs"), { recursive: true });
    fs.mkdirSync(path.join(DEST, "telemetry"), { recursive: true });
    fs.mkdirSync(path.join(DEST, "overrides"), { recursive: true });
  });
  act(`copy agents -> ${AGENTS_DIR} (${AGENT_FILES.join(", ")})`, () => {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
    for (const name of AGENT_FILES) {
      const dst = path.join(AGENTS_DIR, name);
      const src = path.join(HERE, "agents", name);
      if (fs.existsSync(dst) && fs.readFileSync(dst, "utf8") !== fs.readFileSync(src, "utf8")) backup(dst);
      fs.copyFileSync(src, dst);
    }
  });
  act(`${claudeMd.changed ? "add/replace" : "keep (unchanged)"} managed block in ${CLAUDE_MD}`, () => {
    if (!claudeMd.changed) return;
    backup(CLAUDE_MD);
    fs.writeFileSync(CLAUDE_MD, claudeMd.text);
  });
  act(`merge permissions into ${SETTINGS}`, () => {
    const fragment = readJson(path.join(HERE, "settings.permissions.json")).permissions;
    const settings = readJson(SETTINGS);
    const before = JSON.stringify(settings);
    settings.permissions ??= {};
    for (const key of ["allow", "ask"]) {
      settings.permissions[key] = [...new Set([...(settings.permissions[key] ?? []), ...fragment[key]])];
    }
    if (before === JSON.stringify(settings)) return;
    backup(SETTINGS);
    writeJson(SETTINGS, settings);
  });
  act(`record deployed kit version -> ${path.join(DEST, "deployed.json")}`, () => {
    writeJson(path.join(DEST, "deployed.json"), deploymentRecord());
  });
}

/**
 * Describe what is being deployed, so each machine can report which kit version it runs.
 * Input: none (reads the kit's git checkout and the installed model config).
 * Output: { commit, dirty, deployed_at, host, platform, models } — commit/dirty are null
 * when the kit is not a git checkout.
 */
function deploymentRecord() {
  const gitOut = (gitArgs) => {
    const r = spawnSync("git", ["-C", KIT, ...gitArgs], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const commit = gitOut(["rev-parse", "HEAD"]);
  const models = spawnSync(process.execPath, [path.join(DEST, "scripts", "codex-delegate.mjs"), "models", "--json"], { encoding: "utf8" });
  return {
    commit,
    dirty: commit ? gitOut(["status", "--porcelain"]) !== "" : null,
    deployed_at: new Date().toISOString(),
    host: os.hostname(),
    platform: process.platform,
    models: models.status === 0 ? JSON.parse(models.stdout).roles : null
  };
}

function uninstall() {
  act(`remove managed block from ${CLAUDE_MD}`, () => {
    if (!fs.existsSync(CLAUDE_MD)) return;
    const current = fs.readFileSync(CLAUDE_MD, "utf8");
    const { text: next, changed } = removeBlock(current, "claude-md");
    if (!changed) return;
    backup(CLAUDE_MD);
    fs.writeFileSync(CLAUDE_MD, next);
  });
  act(`remove permissions added by this kit from ${SETTINGS}`, () => {
    if (!fs.existsSync(SETTINGS)) return;
    const fragment = readJson(path.join(HERE, "settings.permissions.json")).permissions;
    const settings = readJson(SETTINGS);
    const before = JSON.stringify(settings);
    for (const key of ["allow", "ask"]) {
      if (!settings.permissions?.[key]) continue;
      settings.permissions[key] = settings.permissions[key].filter((r) => !fragment[key].includes(r));
      if (settings.permissions[key].length === 0) delete settings.permissions[key];
    }
    if (settings.permissions && Object.keys(settings.permissions).length === 0) delete settings.permissions;
    if (before === JSON.stringify(settings)) return;
    backup(SETTINGS);
    writeJson(SETTINGS, settings);
  });
  act(`remove agents ${AGENT_FILES.join(", ")}`, () => {
    for (const name of AGENT_FILES) fs.rmSync(path.join(AGENTS_DIR, name), { force: true });
  });
  if (args.has("--purge")) {
    act(`remove ${DEST} (runs, telemetry and overrides included)`, () => fs.rmSync(DEST, { recursive: true, force: true }));
  } else {
    act(`remove ${DEST} except runs/, telemetry/ and overrides/ (pass --purge to delete them)`, () => {
      if (!fs.existsSync(DEST)) return;
      for (const entry of fs.readdirSync(DEST)) {
        if (!["runs", "telemetry", "overrides"].includes(entry)) fs.rmSync(path.join(DEST, entry), { recursive: true, force: true });
      }
    });
  }
}

try {
  if (args.has("--uninstall")) {
    uninstall();
  } else {
    const ok = preflight();
    if (args.has("--check")) process.exit(ok ? 0 : 1);
    if (!ok) console.log("Preflight has failures; installing anyway. Fix them before delegating (see claude/GLOBAL_INSTALL.md).");
    install();
    console.log("Done. Start a NEW Claude Code session so the agents and CLAUDE.md block load.");
  }
} catch (error) {
  if (error instanceof ManagedBlockError) {
    console.error(`${CLAUDE_MD}: ${error.problem} at line(s) ${error.lines.join(", ")}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
