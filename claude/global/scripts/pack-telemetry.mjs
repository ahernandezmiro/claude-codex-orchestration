#!/usr/bin/env node
// Packs the orchestration evaluation data (runs/ + telemetry/) into one zip file for offline analysis.
// Author: maintained with Claude Code for the frontier-model orchestration setup.
//
//   node pack-telemetry.mjs [--out <file.zip>] [--source <orchestration-dir>]... [--all-hosts]
//                           [--exclude-raw] [--exclude-validation] [--dry-run]
//
// Sources (each is an orchestration dir that holds runs/ and/or telemetry/):
//   default        <home>/.claude/orchestration — the same root install.mjs deploys to, i.e.
//                  %USERPROFILE%\.claude\orchestration on Windows and ~/.claude/orchestration on
//                  Linux/WSL/macOS. Run from the repo or the installed copy; both resolve the same.
//   --source <dir> pack this dir instead of the default; repeatable.
//   --all-hosts    also pick up the other side of a Windows/WSL machine: on Windows every WSL
//                  distro's /home/*/.claude/orchestration (via \\wsl.localhost), on WSL every
//                  /mnt/<drive>/Users/*/.claude/orchestration. Reading a stopped distro boots it.
//
// Archive layout: manifest.json at the root, then one folder per source labelled
// <host>-<platform>[-<user>] containing runs/, telemetry/ and, when present, deployed.json and
// config/*.json (models + quota in effect, needed to interpret the runs).
//   --exclude-raw         skip *.prompt.md, *.stdout.txt, *.stderr.txt (worker prompts and output
//                         may contain project code; run.json + events keep all the metrics)
//   --exclude-validation  skip runs/_validation/ and telemetry/_validation/
//
// No external packages: the zip is written with node:zlib (deflate) and a small ZIP32 writer.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DATA_DIRS = ["runs", "telemetry"];
const CONTEXT_FILES = ["deployed.json"];
const CONTEXT_DIRS = ["config"];
const RAW_OUTPUT_SUFFIXES = [".prompt.md", ".stdout.txt", ".stderr.txt"];
const VALIDATION_DIR = "_validation";
const WINDOWS_SKIP_PROFILES = new Set(["Default", "Default User", "Public", "All Users", "WsiAccount"]);
// ZIP32 limits; the evaluation data is far below them, so ZIP64 is not implemented.
const ZIP32_MAX_ENTRIES = 0xffff;
const ZIP32_MAX_BYTES = 0xffffffff;

/**
 * Parse CLI arguments.
 * Input: argv array (without node + script). Output: options object; exits 2 on bad input.
 */
export function parseArgs(argv) {
  const options = { out: null, sources: [], allHosts: false, excludeRaw: false, excludeValidation: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case "--out": options.out = value(); break;
      case "--source": options.sources.push(value()); break;
      case "--all-hosts": options.allHosts = true; break;
      case "--exclude-raw": options.excludeRaw = true; break;
      case "--exclude-validation": options.excludeValidation = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "-h": case "--help": printHelp(); process.exit(0);
      default: fail(`unknown option ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
  console.log(text.slice(1, text.findIndex((line) => line.startsWith("import"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n").trim());
}

function fail(message) {
  console.error(`pack-telemetry: ${message}`);
  process.exit(2);
}

/**
 * Input: none. Output: true when running inside WSL (Linux kernel built by Microsoft).
 */
function isWsl() {
  if (process.platform !== "linux") return false;
  try { return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8")); } catch { return false; }
}

/**
 * Input: directory path. Output: true when it holds at least one of runs/ or telemetry/.
 */
function hasTelemetry(dir) {
  return DATA_DIRS.some((name) => {
    try { return fs.statSync(path.join(dir, name)).isDirectory(); } catch { return false; }
  });
}

/**
 * Input: none. Output: the orchestration dir for the current user, matching install.mjs (homedir/.claude).
 */
export function defaultOrchestrationDir() {
  return path.join(os.homedir(), ".claude", "orchestration");
}

/**
 * Input: none. Output: [{ dir, label }] for WSL distros seen from Windows.
 * Uses `wsl.exe -l -q` (UTF-16LE output) and the \\wsl.localhost share; silently returns []
 * when WSL is absent, so --all-hosts is safe on machines without it.
 */
function discoverWslSources() {
  const listing = spawnSync("wsl.exe", ["-l", "-q"], { encoding: "buffer", timeout: 15000, windowsHide: true });
  if (listing.status !== 0 || !listing.stdout) return [];
  const distros = listing.stdout.toString("utf16le").split(/\r?\n/).map((s) => s.replace(/\0/g, "").trim()).filter(Boolean);
  const found = [];
  for (const distro of distros) {
    const homeRoot = `\\\\wsl.localhost\\${distro}\\home`;
    let users = [];
    try { users = fs.readdirSync(homeRoot); } catch { continue; }
    for (const user of users) {
      const dir = path.win32.join(homeRoot, user, ".claude", "orchestration");
      if (hasTelemetry(dir)) found.push({ dir, label: `wsl-${distro}-${user}` });
    }
  }
  return found;
}

/**
 * Input: none. Output: [{ dir, label }] for Windows user profiles seen from WSL (/mnt/<drive>/Users).
 */
function discoverWindowsSourcesFromWsl() {
  const found = [];
  let drives = [];
  try { drives = fs.readdirSync("/mnt").filter((d) => /^[a-z]$/.test(d)); } catch { return found; }
  for (const drive of drives) {
    const usersRoot = `/mnt/${drive}/Users`;
    let profiles = [];
    try { profiles = fs.readdirSync(usersRoot); } catch { continue; }
    for (const profile of profiles.filter((p) => !WINDOWS_SKIP_PROFILES.has(p))) {
      const dir = path.posix.join(usersRoot, profile, ".claude", "orchestration");
      if (hasTelemetry(dir)) found.push({ dir, label: `windows-${profile}` });
    }
  }
  return found;
}

/**
 * Decide which orchestration dirs to pack.
 * Input: parsed options. Output: [{ dir, label }] with unique dirs and unique labels.
 */
export function resolveSources(options) {
  const host = os.hostname();
  const localLabel = `${host}-${isWsl() ? "wsl" : process.platform}-${os.userInfo().username}`;
  const sources = options.sources.length
    ? options.sources.map((dir, i) => ({ dir: path.resolve(dir), label: `source${i + 1}-${path.basename(path.dirname(path.resolve(dir))) || "root"}` }))
    : [{ dir: defaultOrchestrationDir(), label: localLabel }];
  if (options.allHosts) {
    if (process.platform === "win32") sources.push(...discoverWslSources().map((s) => ({ ...s, label: `${host}-${s.label}` })));
    else if (isWsl()) sources.push(...discoverWindowsSourcesFromWsl().map((s) => ({ ...s, label: `${host}-${s.label}` })));
  }
  const seenDirs = new Set();
  const seenLabels = new Map();
  return sources.filter((s) => {
    const key = path.resolve(s.dir).toLowerCase();
    if (seenDirs.has(key)) return false;
    seenDirs.add(key);
    return true;
  }).map((s) => {
    const safe = s.label.replace(/[^A-Za-z0-9._-]+/g, "_");
    const count = seenLabels.get(safe) ?? 0;
    seenLabels.set(safe, count + 1);
    return { ...s, label: count ? `${safe}-${count + 1}` : safe };
  });
}

/**
 * Recursively list files under a directory.
 * Input: absolute dir. Output: [absolute file paths], sorted for a reproducible archive order.
 */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Collect the files of one source that belong in the archive.
 * Input: { dir, label }, options. Output: [{ absPath, zipPath }]; zipPath always uses "/".
 */
export function collectFiles(source, options) {
  const files = [];
  const add = (absPath) => {
    const rel = path.relative(source.dir, absPath).split(path.sep).join("/");
    const parts = rel.split("/");
    if (options.excludeValidation && parts[1] === VALIDATION_DIR) return;
    if (options.excludeRaw && RAW_OUTPUT_SUFFIXES.some((suffix) => rel.endsWith(suffix))) return;
    files.push({ absPath, zipPath: `${source.label}/${rel}` });
  };
  for (const name of [...DATA_DIRS, ...CONTEXT_DIRS]) {
    const sub = path.join(source.dir, name);
    if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) {
      for (const file of walk(sub)) {
        // config/ is context only: models/quota JSON, not backups or other leftovers.
        if (CONTEXT_DIRS.includes(name) && !file.endsWith(".json")) continue;
        add(file);
      }
    }
  }
  for (const name of CONTEXT_FILES) {
    const file = path.join(source.dir, name);
    if (fs.existsSync(file)) add(file);
  }
  return files;
}

// --- Minimal ZIP32 writer -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Input: Buffer. Output: unsigned CRC-32 (zlib.crc32 needs Node 22, the kit supports 18+). */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Input: Date. Output: { time, date } in MS-DOS format (local time, 2-second resolution). */
function dosDateTime(when) {
  const year = Math.max(1980, when.getFullYear());
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()
  };
}

/**
 * Build a zip archive in memory.
 * Input: [{ name, data: Buffer, mtime: Date }]. Output: Buffer with the complete archive.
 * Entries are deflated unless that makes them larger (then stored). Names are flagged UTF-8.
 */
export function buildZip(entries) {
  if (entries.length > ZIP32_MAX_ENTRIES) throw new Error(`too many files for ZIP32 (${entries.length})`);
  const UTF8_FLAG = 0x0800;
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const method = deflated.length < entry.data.length ? 8 : 0;
    const body = method === 8 ? deflated : entry.data;
    const crc = crc32(entry.data);
    const { time, date } = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8_FLAG, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    // extra len, comment len, disk start, internal attrs, external attrs: all zero.
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    chunks.push(local, name, body);
    offset += local.length + name.length + body.length;
    if (offset > ZIP32_MAX_BYTES) throw new Error("archive exceeds 4 GiB (ZIP32 limit)");
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

// --- Main -----------------------------------------------------------------------------------

/**
 * Pack the selected sources.
 * Input: parsed options. Output: { outPath, manifest, written: boolean }.
 * Sources without runs/ or telemetry/ are reported in the manifest as skipped, not fatal;
 * it fails (exit 1) only when no source has any data at all.
 */
export function pack(options) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.resolve(options.out ?? `orchestration-telemetry-${os.hostname()}-${stamp}.zip`);
  const manifest = {
    generated_at: new Date().toISOString(),
    generator: "orchestration-kit/claude/global/scripts/pack-telemetry.mjs",
    host: os.hostname(),
    platform: isWsl() ? "wsl" : process.platform,
    options: { exclude_raw: options.excludeRaw, exclude_validation: options.excludeValidation, all_hosts: options.allHosts },
    sources: []
  };
  const entries = [];
  for (const source of resolveSources(options)) {
    if (!hasTelemetry(source.dir)) {
      manifest.sources.push({ label: source.label, dir: source.dir, skipped: "no runs/ or telemetry/ directory" });
      continue;
    }
    const files = collectFiles(source, options);
    const summary = { label: source.label, dir: source.dir, files: files.length, bytes: 0, run_records: 0, event_lines: 0 };
    for (const file of files) {
      const data = fs.readFileSync(file.absPath);
      summary.bytes += data.length;
      if (file.zipPath.endsWith(".run.json")) summary.run_records++;
      if (file.zipPath.endsWith(".jsonl")) summary.event_lines += data.toString("utf8").split("\n").filter((l) => l.trim()).length;
      entries.push({ name: file.zipPath, data, mtime: fs.statSync(file.absPath).mtime });
    }
    manifest.sources.push(summary);
  }
  if (!entries.length) {
    console.error("pack-telemetry: no telemetry found in:");
    for (const s of manifest.sources) console.error(`  ${s.dir} (${s.skipped})`);
    process.exit(1);
  }
  entries.unshift({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), mtime: new Date() });
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buildZip(entries));
  }
  return { outPath, manifest, written: !options.dryRun };
}

function main() {
  const { outPath, manifest, written } = pack(parseArgs(process.argv.slice(2)));
  for (const s of manifest.sources) {
    if (s.skipped) console.log(`skip  ${s.dir}: ${s.skipped}`);
    else console.log(`pack  ${s.dir} -> ${s.label}/  (${s.files} files, ${s.run_records} runs, ${s.event_lines} telemetry lines, ${(s.bytes / 1024).toFixed(1)} KiB)`);
  }
  console.log(written ? `wrote ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KiB)` : `[dry-run] would write ${outPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
