#!/usr/bin/env node
// Prompt-freeze guard for the orchestration kit.
// Author: maintained with Claude Code for the frontier-model orchestration setup.
//
// Why: the evaluation period compares delegations over time, so every prompt the
// orchestrator, the subagents and the Codex workers see must stay byte-identical while
// model/effort selection changes. This script proves that before anything is deployed.
//
//   node claude/global/test/prompt-freeze.mjs            check (exit 0 = frozen, 1 = drift)
//   node claude/global/test/prompt-freeze.mjs --update   re-baseline after the evaluation closes
//
// Two checks:
//   1. Worker prompts: stage the installed layout in a temp dir, run
//      `codex-delegate.mjs run --dry-run` for every role with a stub companion, and compare
//      each generated prompt with golden/<role>.golden.md. This covers the wrapper's own
//      prompt text (buildPrompt, worker display names) as well as the inlined docs.
//   2. Orchestrator/agent prompts: sha256 of the files Claude loads (CLAUDE.md block source,
//      imported policy docs, role docs, subagent definitions) against golden/static-prompts.sha256.json.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const GOLDEN_DIR = path.join(HERE, "golden");
const STATIC_MANIFEST = path.join(GOLDEN_DIR, "static-prompts.sha256.json");
const UPDATE = process.argv.includes("--update");

// One dry run per role; packets come from this test folder.
const WORKER_CASES = [
  { role: "luna-implement", packet: "T001-slugify.yaml" },
  { role: "luna-test", packet: "T001-slugify.yaml" },
  { role: "sol-implement", packet: "T001-slugify.yaml" },
  { role: "astra-review", packet: "R001-slug-registry.yaml" },
  { role: "astra-investigate", packet: "I001-investigate.yaml" }
];

/**
 * List the repo files whose text Claude or a subagent reads as instructions.
 * Input: none. Output: sorted repo-relative POSIX paths.
 */
function staticPromptFiles() {
  const list = (dir, accept) => fs.readdirSync(path.join(REPO, dir))
    .filter(accept)
    .map((name) => `${dir}/${name}`);
  const recursiveList = (dir) => fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory() ? recursiveList(`${dir}/${entry.name}`) : [entry.name.endsWith(".md") ? `${dir}/${entry.name}` : null])
    .filter(Boolean);
  return [
    "claude/CLAUDE.md",
    ...list("claude", (n) => /^ROLE_.*\.md$/.test(n)),
    "claude/global/CLAUDE.orchestration.md",
    ...list("claude/global/agents", (n) => n.endsWith(".md")),
    ...list("codex", (n) => n.endsWith(".md")),
    ...recursiveList("codex/prompts"),
    "shared/ROUTING_POLICY.md",
    "shared/TASK_CONTRACT.md",
    "shared/REVIEW_CONTRACT.md",
    "shared/CREATIVE_PIPELINE_RULES.md"
  ].sort();
}

/**
 * Hash a file's exact bytes.
 * Input: absolute path. Output: hex sha256 string.
 */
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Recursively copy a directory (Node 18 compatible, no fs.cpSync dependency).
 * Input: source and destination absolute paths. Output: none.
 */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Build a throwaway copy of the installed ~/.claude/orchestration layout.
 * Input: none. Output: { stage, companion } absolute paths; caller removes stage.
 */
function stageInstalledLayout() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-freeze-"));
  copyDir(path.join(REPO, "shared"), path.join(stage, "shared"));
  copyDir(path.join(REPO, "codex"), path.join(stage, "codex"));
  copyDir(path.join(REPO, "claude", "global", "scripts"), path.join(stage, "scripts"));
  const config = path.join(REPO, "claude", "global", "config");
  if (fs.existsSync(config)) copyDir(config, path.join(stage, "config"));
  // Dry runs only need the companion path to exist; it is never executed.
  const companion = path.join(stage, "stub-codex-companion.mjs");
  fs.writeFileSync(companion, "process.exit(99);\n");
  const sentinel = path.join(stage, "sentinel-codex.mjs");
  fs.writeFileSync(sentinel, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(path.join(stage, "sentinel-marker.txt"))}, "called\\n"); process.exit(97);\n`);
  return { stage, companion, sentinel };
}

/**
 * Generate the worker prompt for one role through the real wrapper in dry-run mode.
 * Input: staged layout, role case. Output: prompt text, or throws with wrapper output.
 */
function generateWorkerPrompt({ stage, companion, sentinel }, { role, packet }) {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-freeze-home-"));
  // A real user override must never leak into a golden, so the wrapper sees an empty home.
  try {
    const r = spawnSync(process.execPath, [
      path.join(stage, "scripts", "codex-delegate.mjs"), "run",
      "--role", role, "--packet", path.join(HERE, packet), "--cwd", stage, "--dry-run"
    ], { encoding: "utf8", env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, APPDATA: isolatedHome, ORCH_BACKEND: "companion", CODEX_BIN: sentinel, CODEX_COMPANION: companion } });
    if (r.status !== 0) throw new Error(`dry run failed for ${role} (exit ${r.status}):\n${r.stdout}${r.stderr}`);
    const promptLine = r.stdout.split(/\r?\n/).find((l) => l.startsWith("DELEGATE: prompt="));
    if (!promptLine) throw new Error(`no prompt path reported for ${role}:\n${r.stdout}`);
    return fs.readFileSync(promptLine.slice("DELEGATE: prompt=".length).trim(), "utf8");
  } finally {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

/**
 * Report the first differing line between two texts.
 * Input: expected and actual strings. Output: human-readable one-line description.
 */
function firstDifference(expected, actual) {
  const a = expected.split("\n");
  const b = actual.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1}: expected ${JSON.stringify(a[i] ?? "<eof>")} got ${JSON.stringify(b[i] ?? "<eof>")}`;
  }
  return "identical text, different bytes";
}

/**
 * Run both checks (or rewrite the golden files with --update).
 * Input: none. Output: process exit code (0 frozen/updated, 1 drift).
 */
function main() {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  const problems = [];
  const staged = stageInstalledLayout();
  try {
    for (const workerCase of WORKER_CASES) {
      const prompt = generateWorkerPrompt(staged, workerCase);
      const golden = path.join(GOLDEN_DIR, `${workerCase.role}.golden.md`);
      if (UPDATE) {
        const oldBytes = fs.existsSync(golden) ? fs.statSync(golden).size : 0;
        fs.writeFileSync(golden, prompt);
        console.log(`${workerCase.role}: ${oldBytes} -> ${Buffer.byteLength(prompt, "utf8")}`);
      }
      else if (!fs.existsSync(golden)) problems.push(`${workerCase.role}: golden prompt missing (run --update on the baseline)`);
      else if (fs.readFileSync(golden, "utf8") !== prompt) {
        problems.push(`${workerCase.role} worker prompt changed — ${firstDifference(fs.readFileSync(golden, "utf8"), prompt)}`);
      }
    }
  } finally {
    fs.rmSync(staged.stage, { recursive: true, force: true });
  }

  const hashes = Object.fromEntries(staticPromptFiles().map((rel) => [rel, sha256(path.join(REPO, rel))]));
  if (UPDATE) {
    fs.writeFileSync(STATIC_MANIFEST, JSON.stringify(hashes, null, 2) + "\n");
  } else {
    const expected = fs.existsSync(STATIC_MANIFEST) ? JSON.parse(fs.readFileSync(STATIC_MANIFEST, "utf8")) : {};
    for (const rel of new Set([...Object.keys(expected), ...Object.keys(hashes)])) {
      if (expected[rel] !== hashes[rel]) {
        problems.push(`${rel}: ${!expected[rel] ? "new prompt file" : !hashes[rel] ? "prompt file removed" : "content changed"}`);
      }
    }
  }

  if (UPDATE) {
    console.log(`PROMPT FREEZE: golden files updated in ${path.relative(REPO, GOLDEN_DIR)}`);
    return 0;
  }
  if (problems.length) {
    console.log("PROMPT FREEZE: DRIFT");
    for (const p of problems) console.log(`  - ${p}`);
    console.log("Prompts are frozen for the evaluation period. Revert the change, or re-baseline with --update once the evaluation is closed.");
    return 1;
  }
  console.log(`PROMPT FREEZE: OK (${WORKER_CASES.length} worker prompts, ${Object.keys(hashes).length} orchestrator/agent prompt files)`);
  return 0;
}

process.exit(main());
