import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.resolve(HERE, "..", "install.mjs");
const BODY = "@~/.claude/orchestration/claude/CLAUDE.orchestration.md";
const NEW_BLOCK = `<!-- BEGIN orchestration-kit:claude-md -->\n${BODY}\n<!-- END orchestration-kit:claude-md -->`;
const LEGACY_BLOCK = "<!-- BEGIN frontier-orchestration (managed by frontier_model_orchestration/claude/global/install.mjs) -->\nlegacy contents\n<!-- END frontier-orchestration -->";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "installer-test-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), APPDATA: home };
  const claude = path.join(home, ".claude");
  const claudeMd = path.join(claude, "CLAUDE.md");
  const settings = path.join(claude, "settings.json");
  const run = (...args) => spawnSync(process.execPath, [INSTALLER, ...args], { encoding: "utf8", env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const backups = () => {
    if (!fs.existsSync(claude)) return [];
    const found = [];
    const visit = (dirPath) => {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.name.includes(".bak-")) found.push(full);
      }
    };
    visit(claude);
    return found;
  };
  return { dir, home, claude, claudeMd, settings, env, run, backups };
}

test("fresh install writes the 3-line block", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(f.claudeMd, "utf8"), `${NEW_BLOCK}\n`);
  assert.equal(fs.readFileSync(path.join(f.claude, "orchestration", "claude", "CLAUDE.orchestration.md"), "utf8"), fs.readFileSync(path.resolve(HERE, "..", "CLAUDE.orchestration.md"), "utf8"));
  assert.ok(fs.existsSync(path.join(f.claude, "orchestration", "overrides")));
});

test("second install leaves CLAUDE.md and settings.json alone", (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const before = [f.claudeMd, f.settings].map((file) => ({ content: fs.readFileSync(file, "utf8"), mtime: fs.statSync(file).mtimeMs }));
  const backupCount = f.backups().length;
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const [index, file] of [f.claudeMd, f.settings].entries()) {
    assert.equal(fs.readFileSync(file, "utf8"), before[index].content);
    assert.equal(fs.statSync(file).mtimeMs, before[index].mtime);
  }
  assert.equal(f.backups().length, backupCount);
});

test("legacy block migrates", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.claude, { recursive: true });
  fs.writeFileSync(f.claudeMd, `mine\n\n${LEGACY_BLOCK}\ntail\n`);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(f.claudeMd, "utf8"), `mine\n\n${NEW_BLOCK}\ntail\n`);
});

test("malformed markers abort install and uninstall", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.claude, { recursive: true });
  const malformed = "before\n<!-- BEGIN orchestration-kit:claude-md -->\nbody\n";
  fs.writeFileSync(f.claudeMd, malformed);
  for (const args of [[], ["--uninstall"]]) {
    const result = f.run(...args);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(f.claudeMd, "utf8"), malformed);
    assert.ok(result.stderr.includes(f.claudeMd));
    assert.match(result.stderr, /unmatched-begin/);
  }
  // The install refused before touching anything else.
  assert.equal(fs.existsSync(path.join(f.claude, "orchestration", "scripts")), false);
  assert.equal(fs.existsSync(path.join(f.claude, "agents", "luna-worker.md")), false);
});

test("AGENTS.md files untouched", (t) => {
  const f = fixture(t);
  const codexAgents = path.join(f.home, ".codex", "AGENTS.md");
  const project = path.join(f.dir, "proj");
  const projectAgents = path.join(project, "AGENTS.md");
  fs.mkdirSync(path.dirname(codexAgents), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(codexAgents, "codex user data\n");
  fs.writeFileSync(projectAgents, "project user data\n");
  const originals = [fs.readFileSync(codexAgents), fs.readFileSync(projectAgents)];
  const installed = f.run();
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.deepEqual(fs.readFileSync(codexAgents), originals[0]);
  assert.deepEqual(fs.readFileSync(projectAgents), originals[1]);
  const removed = f.run("--uninstall");
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.deepEqual(fs.readFileSync(codexAgents), originals[0]);
  assert.deepEqual(fs.readFileSync(projectAgents), originals[1]);
});

test("overrides survive reinstall and uninstall", (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const override = path.join(f.claude, "orchestration", "overrides", "roles", "luna-test.md");
  fs.mkdirSync(path.dirname(override), { recursive: true });
  fs.writeFileSync(override, "user prompt\n");
  assert.equal(f.run().status, 0);
  assert.equal(fs.readFileSync(override, "utf8"), "user prompt\n");
  const removed = f.run("--uninstall");
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.equal(fs.readFileSync(override, "utf8"), "user prompt\n");
  const purged = f.run("--uninstall", "--purge");
  assert.equal(purged.status, 0, purged.stdout + purged.stderr);
  assert.equal(fs.existsSync(override), false);
});

test("uninstall without block writes nothing", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.claude, { recursive: true });
  fs.writeFileSync(f.claudeMd, "user instructions\n");
  const mtime = fs.statSync(f.claudeMd).mtimeMs;
  const result = f.run("--uninstall");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.statSync(f.claudeMd).mtimeMs, mtime);
  assert.equal(f.backups().length, 0);
});
