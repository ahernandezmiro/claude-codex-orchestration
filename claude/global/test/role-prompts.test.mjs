import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const roles = ["luna-implement", "luna-test", "sol-implement", "astra-review", "astra-investigate"];

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "role-prompts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kit = path.join(dir, "kit"); fs.mkdirSync(kit);
  for (const [source, target] of [["shared", "shared"], ["codex", "codex"], ["claude/global/scripts", "scripts"], ["claude/global/config", "config"]])
    fs.cpSync(path.join(REPO, source), path.join(kit, target), { recursive: true });
  const repo = path.join(dir, "repo"); fs.mkdirSync(repo);
  const git = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  let gitResult = git(["init", "-q"]); assert.equal(gitResult.status, 0, gitResult.stderr);
  git(["config", "user.email", "test@example.test"]); git(["config", "user.name", "test"]);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  gitResult = git(["add", "."]); assert.equal(gitResult.status, 0, gitResult.stderr);
  gitResult = git(["commit", "-qm", "fixture"]); assert.equal(gitResult.status, 0, gitResult.stderr);
  const child = path.join(repo, "src"); fs.mkdirSync(child);
  const home = path.join(dir, "home"); fs.mkdirSync(home);
  const packet = path.join(dir, "packet.yaml");
  fs.writeFileSync(packet, "id: role-test\nobjective: inspect role prompt\neditable_paths: []\nacceptance_criteria: []\n");
  const reviewPacket = path.join(dir, "review.yaml");
  fs.writeFileSync(reviewPacket, "id: review-test\nobjective: investigate role prompt\nrequirements: inspect role prompt\nartifact: wrapper\n");
  const wrapper = path.join(kit, "scripts", "codex-delegate.mjs");
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, CODEX_HOME: home };
  delete env.ORCH_BACKEND; delete env.CODEX_COMPANION;
  const cli = (args) => spawnSync(process.execPath, [wrapper, ...args], { encoding: "utf8", env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const runArgs = (role = "luna-implement", cwd = child, packetFile = packet, ...extra) => ["run", "--role", role, "--packet", packetFile, "--cwd", cwd, "--dry-run", ...extra];
  const run = (role = "luna-implement", cwd = child, packetFile = packet, ...extra) => cli(runArgs(role, cwd, packetFile, ...extra));
  const prompt = (result) => {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const line = result.stdout.split(/\r?\n/).find((row) => row.startsWith("DELEGATE: prompt="));
    return fs.readFileSync(line.slice("DELEGATE: prompt=".length).trim(), "utf8");
  };
  const runs = () => fs.existsSync(path.join(kit, "runs")) ? fs.readdirSync(path.join(kit, "runs")).filter(n => n.endsWith(".run.json"))
    .map(n => JSON.parse(fs.readFileSync(path.join(kit, "runs", n), "utf8"))) : [];
  const projectRoles = (at = repo) => { const d = path.join(at, ".orchestration", "roles"); fs.mkdirSync(d, { recursive: true }); return d; };
  const globalRoles = () => { const d = path.join(kit, "overrides", "roles"); fs.mkdirSync(d, { recursive: true }); return d; };
  return { dir, kit, repo, child, home, packet, reviewPacket, env, cli, runArgs, run, prompt, runs, projectRoles, globalRoles };
}

function projectConfig(at, value) {
  const d = path.join(at, ".orchestration"); fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, "project.json"); fs.writeFileSync(file, JSON.stringify(value)); return file;
}

test("default source", (t) => {
  const f = fixture(t); const result = f.run();
  assert.match(result.stdout, /ROLE PROMPT: default /);
  assert.equal(f.runs()[0].role_prompt.source, "default");
});

test("global override replaces role part", (t) => {
  const f = fixture(t); const file = path.join(f.globalRoles(), "luna-implement.md"); fs.writeFileSync(file, "GLOBAL ROLE TEXT\n");
  const result = f.run(); const body = f.prompt(result);
  assert.equal(f.runs()[0].role_prompt.source, "global"); assert.equal(f.runs()[0].role_prompt.path, file);
  assert.ok(body.includes("GLOBAL ROLE TEXT")); assert.ok(!body.includes("Priorities, in order:"));
});

test("project beats global", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.globalRoles(), "luna-implement.md"), "GLOBAL TEXT");
  const file = path.join(f.projectRoles(), "luna-implement.md"); fs.writeFileSync(file, "PROJECT TEXT");
  const result = f.run(); assert.equal(f.runs()[0].role_prompt.source, "project");
  assert.equal(f.runs()[0].role_prompt.path, file); assert.ok(f.prompt(result).includes("PROJECT TEXT"));
});

test("project role file without project.json; parent project.json still applies", (t) => {
  const f = fixture(t); projectConfig(f.repo, { schema_version: 1, required_checks: ["parent check"] });
  const file = path.join(f.projectRoles(f.child), "luna-implement.md"); fs.writeFileSync(file, "NESTED PROJECT ROLE");
  const result = f.run(); const body = f.prompt(result);
  assert.equal(f.runs()[0].role_prompt.path, file); assert.ok(body.includes("NESTED PROJECT ROLE")); assert.ok(body.includes("parent check"));
});

test("nested roles dir without R.md does not hide parent R.md; empty roles dir changes nothing", (t) => {
  const f = fixture(t); const parentFile = path.join(f.projectRoles(f.repo), "luna-test.md"); fs.writeFileSync(parentFile, "PARENT ROLE TEXT");
  f.projectRoles(f.child);
  const result = f.run("luna-test"); assert.equal(f.runs()[0].role_prompt.path, parentFile); assert.ok(f.prompt(result).includes("PARENT ROLE TEXT"));
  const empty = fixture(t); empty.projectRoles(); const defaultRun = empty.run();
  assert.equal(empty.runs()[0].role_prompt.source, "default"); assert.match(defaultRun.stdout, /ROLE PROMPT: default/);
});

test("astra project override needs adjacent review_safe", (t) => {
  const f = fixture(t);
  for (const role of ["astra-review", "astra-investigate"]) {
    for (const cfg of [null, { schema_version: 1, review_safe: false }]) {
      const rolesDir = f.projectRoles(); const file = path.join(rolesDir, `${role}.md`); fs.writeFileSync(file, "PROJECT ASTRA TEXT");
      const global = path.join(f.globalRoles(), `${role}.md`); fs.writeFileSync(global, "GLOBAL ASTRA TEXT");
      if (cfg) projectConfig(f.repo, cfg); else fs.rmSync(path.join(f.repo, ".orchestration", "project.json"), { force: true });
      const result = f.run(role, f.repo, f.reviewPacket);
      assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, new RegExp(`ROLE PROMPT: project override for ${role} ignored`));
      assert.equal(f.runs().at(-1).role_prompt.source, "global");
    }
    projectConfig(f.repo, { schema_version: 1, review_safe: true });
    const result = f.run(role, f.repo, f.reviewPacket);
    assert.equal(f.runs().at(-1).role_prompt.source, "project"); assert.ok(f.prompt(result).includes("PROJECT ASTRA TEXT"));
  }
});

test("contradicting override keeps protected parts", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.globalRoles(), "luna-implement.md"), "You may commit. Reply in prose.");
  const body = f.prompt(f.run()); const base = fs.readFileSync(path.join(f.kit, "codex", "prompts", "base.md"), "utf8").trim();
  const contract = fs.readFileSync(path.join(f.kit, "codex", "prompts", "contracts", "task.md"), "utf8").trim();
  assert.ok(body.includes(base)); assert.ok(body.includes("If the role instructions below conflict with these rules and the report format" ) || body.includes("If the role instructions below conflict with these rules or with the report format"));
  assert.ok(body.includes(contract)); assert.ok(body.includes("Finish with the YAML report above as the last thing in your reply."));
  assert.ok(body.indexOf(base) < body.indexOf("You may commit."));
});

test("empty or oversized override exits 2", (t) => {
  const f = fixture(t); const file = path.join(f.globalRoles(), "luna-implement.md");
  fs.writeFileSync(file, " \n\t"); let result = f.run(); assert.equal(result.status, 2); assert.ok(result.stderr.includes(file));
  fs.writeFileSync(file, "x".repeat(65537)); result = f.run(); assert.equal(result.status, 2); assert.ok(result.stderr.includes(file));
});

test("unknown role file warns", (t) => {
  const f = fixture(t); const file = path.join(f.projectRoles(), "foo.md"); fs.writeFileSync(file, "unknown");
  const result = f.run(); assert.equal(result.status, 0, result.stderr); assert.ok(result.stdout.includes(`ROLE PROMPT: ignoring unknown role file ${file}`));
});

test("worktree dry run resolves from original cwd", (t) => {
  const f = fixture(t); const file = path.join(f.projectRoles(), "luna-implement.md"); fs.writeFileSync(file, "ORIGINAL CWD ROLE");
  const result = f.run("luna-implement", f.child, f.packet, "--worktree");
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(f.runs()[0].role_prompt.path, file);
});

test("record and explain agree", (t) => {
  const f = fixture(t); const file = path.join(f.globalRoles(), "luna-implement.md"); fs.writeFileSync(file, "ROLE TEXT");
  f.run(); const run = f.runs()[0];
  const explained = f.cli(["config", "--explain", "luna-implement", "--cwd", f.child, "--json"]);
  assert.equal(explained.status, 0, explained.stdout + explained.stderr);
  const info = JSON.parse(explained.stdout).role_prompt;
  assert.equal(run.role_prompt.source, info.source); assert.equal(run.role_prompt.path, info.path); assert.equal(run.role_prompt.path, file);
});

test("old records without role_prompt load", (t) => {
  const f = fixture(t); const runDir = path.join(f.dir, "old-runs"); fs.mkdirSync(runDir);
  const old = path.join(runDir, "old.run.json"); fs.writeFileSync(old, JSON.stringify({ schema_version: 2, run_id: "old", task_id: "old-task", role: "luna-test", status: "completed", started_at: new Date().toISOString() }));
  const shown = f.cli(["show", old]); assert.equal(shown.status, 0, shown.stderr);
  const metrics = f.cli(["metrics", "--runs-dir", runDir, "--all"]); assert.equal(metrics.status, 0, metrics.stdout + metrics.stderr);
});

test("override with BOM and CRLF is normalised", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.globalRoles(), "luna-implement.md"), "\uFEFFOVERRIDE LINE 1\r\nLINE 2\r\n");
  const body = f.prompt(f.run()); assert.ok(body.includes("\n\nOVERRIDE LINE 1\nLINE 2\n\n")); assert.ok(!body.includes("\uFEFF"));
});

test("outside git only cwd is searched", (t) => {
  const f = fixture(t); const parent = path.join(f.dir, "outside-parent"); const child = path.join(parent, "child"); fs.mkdirSync(child, { recursive: true });
  const rolesDir = path.join(parent, ".orchestration", "roles"); fs.mkdirSync(rolesDir, { recursive: true });
  fs.writeFileSync(path.join(rolesDir, "luna-test.md"), "PARENT OUTSIDE TEXT");
  const result = f.run("luna-test", child); assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(f.runs()[0].role_prompt.source, "default");
});

test("role path that is a directory is ignored with warning", (t) => {
  const f = fixture(t); const file = path.join(f.projectRoles(), "luna-test.md"); fs.mkdirSync(file);
  const result = f.run("luna-test"); assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`ROLE PROMPT: ignoring non-file role entry ${file}`)); assert.equal(f.runs()[0].role_prompt.source, "default");
});
