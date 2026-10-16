#!/usr/bin/env node
// Installs the Claude-side orchestration setup into ~/.claude (idempotent).
//
//   node claude/global/install.mjs --check       preflight only, changes nothing
//   node claude/global/install.mjs --dry-run     show what would change
//   node claude/global/install.mjs               install / update
//   node claude/global/install.mjs --uninstall   remove everything this installer added, except run/telemetry data
//   node claude/global/install.mjs --uninstall --purge   also delete runs/ and telemetry/
//
// See claude/GLOBAL_INSTALL.md for the manual, step-by-step equivalent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, "..", "..");
const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const DEST = path.join(CLAUDE_HOME, "orchestration");
const AGENTS_DIR = path.join(CLAUDE_HOME, "agents");
const CLAUDE_MD = path.join(CLAUDE_HOME, "CLAUDE.md");
const SETTINGS = path.join(CLAUDE_HOME, "settings.json");
const BEGIN = "<!-- BEGIN frontier-orchestration (managed by frontier_model_orchestration/claude/global/install.mjs) -->";
const END = "<!-- END frontier-orchestration -->";
const AGENT_FILES = ["luna-worker.md", "astra-reviewer.md"];
const REQUIRED_MODELS = ["gpt-6-luna", "gpt-6-astra", "gpt-6-sol"];

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
  const codex = run("codex", ["--version"]);
  check("codex CLI on PATH", codex.ok, codex.out.split("\n").pop());
  const login = run("codex", ["login", "status"]);
  check("codex logged in", login.ok && /logged in/i.test(login.out), login.out.split("\n").pop());
  const cache = path.join(os.homedir(), ".codex", "models_cache.json");
  let slugs = [];
  try {
    const data = JSON.parse(fs.readFileSync(cache, "utf8"));
    slugs = (data.models ?? data).map((m) => m.slug);
  } catch { /* cache missing until Codex has run once */ }
  for (const model of REQUIRED_MODELS) {
    check(`model id ${model}`, slugs.includes(model), slugs.length ? "" : "models_cache.json not readable; run codex once");
  }
  const wrapper = path.join(HERE, "scripts", "codex-delegate.mjs");
  const which = spawnSync(process.execPath, [wrapper, "which"], { encoding: "utf8" });
  check("OpenAI 'codex' Claude plugin (codex-companion.mjs)", which.status === 0, (which.stdout || which.stderr).trim());
  const mcp = run("codex", ["mcp-server", "--help"]);
  console.log(`  [info] codex mcp-server ${/Usage: codex(.exe)? mcp-server/i.test(mcp.out) ? "available (codex-dispatch plugin usable)" : "not available (codex-dispatch plugin unusable)"}`);
  return ok;
}

function install() {
  act(`copy kit docs -> ${DEST}/{shared,codex,claude}`, () => {
    copyDir(path.join(KIT, "shared"), path.join(DEST, "shared"));
    copyDir(path.join(KIT, "codex"), path.join(DEST, "codex"));
    copyDir(path.join(KIT, "claude"), path.join(DEST, "claude"), (e) => e.isFile() && e.name.endsWith(".md"));
  });
  act(`copy wrapper + templates -> ${DEST}/{scripts,templates}`, () => {
    copyDir(path.join(HERE, "scripts"), path.join(DEST, "scripts"));
    copyDir(path.join(HERE, "templates"), path.join(DEST, "templates"));
    fs.mkdirSync(path.join(DEST, "runs"), { recursive: true });
    fs.mkdirSync(path.join(DEST, "telemetry"), { recursive: true });
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
  act(`add/replace managed block in ${CLAUDE_MD}`, () => {
    const block = `${BEGIN}\n${fs.readFileSync(path.join(HERE, "CLAUDE.orchestration.md"), "utf8").trim()}\n${END}`;
    const current = fs.existsSync(CLAUDE_MD) ? fs.readFileSync(CLAUDE_MD, "utf8") : "";
    backup(CLAUDE_MD);
    const pattern = new RegExp(`${escape(BEGIN)}[\\s\\S]*?${escape(END)}`);
    const next = pattern.test(current) ? current.replace(pattern, block) : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
    fs.writeFileSync(CLAUDE_MD, next);
  });
  act(`merge permissions into ${SETTINGS}`, () => {
    const fragment = readJson(path.join(HERE, "settings.permissions.json")).permissions;
    const settings = readJson(SETTINGS);
    backup(SETTINGS);
    settings.permissions ??= {};
    for (const key of ["allow", "ask"]) {
      settings.permissions[key] = [...new Set([...(settings.permissions[key] ?? []), ...fragment[key]])];
    }
    writeJson(SETTINGS, settings);
  });
}

function uninstall() {
  act(`remove managed block from ${CLAUDE_MD}`, () => {
    if (!fs.existsSync(CLAUDE_MD)) return;
    backup(CLAUDE_MD);
    const pattern = new RegExp(`\\n*${escape(BEGIN)}[\\s\\S]*?${escape(END)}\\n?`);
    fs.writeFileSync(CLAUDE_MD, fs.readFileSync(CLAUDE_MD, "utf8").replace(pattern, "\n"));
  });
  act(`remove permissions added by this kit from ${SETTINGS}`, () => {
    if (!fs.existsSync(SETTINGS)) return;
    const fragment = readJson(path.join(HERE, "settings.permissions.json")).permissions;
    const settings = readJson(SETTINGS);
    backup(SETTINGS);
    for (const key of ["allow", "ask"]) {
      if (!settings.permissions?.[key]) continue;
      settings.permissions[key] = settings.permissions[key].filter((r) => !fragment[key].includes(r));
      if (settings.permissions[key].length === 0) delete settings.permissions[key];
    }
    if (settings.permissions && Object.keys(settings.permissions).length === 0) delete settings.permissions;
    writeJson(SETTINGS, settings);
  });
  act(`remove agents ${AGENT_FILES.join(", ")}`, () => {
    for (const name of AGENT_FILES) fs.rmSync(path.join(AGENTS_DIR, name), { force: true });
  });
  if (args.has("--purge")) {
    act(`remove ${DEST} (run and telemetry data included)`, () => fs.rmSync(DEST, { recursive: true, force: true }));
  } else {
    act(`remove ${DEST} except runs/ and telemetry/ (pass --purge to delete them)`, () => {
      if (!fs.existsSync(DEST)) return;
      for (const entry of fs.readdirSync(DEST)) {
        if (!["runs", "telemetry"].includes(entry)) fs.rmSync(path.join(DEST, entry), { recursive: true, force: true });
      }
    });
  }
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (args.has("--uninstall")) {
  uninstall();
} else {
  const ok = preflight();
  if (args.has("--check")) process.exit(ok ? 0 : 1);
  if (!ok) console.log("Preflight has failures; installing anyway. Fix them before delegating (see claude/GLOBAL_INSTALL.md).");
  install();
  console.log("Done. Start a NEW Claude Code session so the agents and CLAUDE.md block load.");
}
