import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseWorkerReport } from "../scripts/telemetry-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const roles = ["luna-implement", "luna-test", "sol-implement", "astra-review", "astra-investigate"];

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-structure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kit = path.join(dir, "kit"); fs.mkdirSync(kit);
  for (const [source, target] of [["shared", "shared"], ["codex", "codex"], ["claude/global/scripts", "scripts"], ["claude/global/config", "config"]])
    fs.cpSync(path.join(REPO, source), path.join(kit, target), { recursive: true });
  const cwd = path.join(dir, "cwd"); fs.mkdirSync(cwd);
  const home = path.join(dir, "home"); fs.mkdirSync(home);
  const packet = path.join(dir, "packet.yaml");
  fs.writeFileSync(packet, "id: prompt-test\nobjective: inspect prompt\neditable_paths: []\nacceptance_criteria: []\n");
  const reviewPacket = path.join(dir, "review.yaml");
  fs.writeFileSync(reviewPacket, "id: creative-review\nrequirements: review creative asset\nartifact: model\nfocus:\n  - '3D: topology assumptions; rig feasibility'\n");
  const wrapper = path.join(kit, "scripts", "codex-delegate.mjs");
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, CODEX_HOME: home };
  delete env.ORCH_BACKEND; delete env.CODEX_COMPANION;
  const cli = (role, selectedPacket = packet) => spawnSync(process.execPath, [wrapper, "run", "--role", role, "--packet", selectedPacket, "--cwd", cwd, "--dry-run"], { encoding: "utf8", env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const promptFor = (role, result) => {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const line = result.stdout.split(/\r?\n/).find((row) => row.startsWith("DELEGATE: prompt="));
    return fs.readFileSync(line.slice("DELEGATE: prompt=".length).trim(), "utf8");
  };
  return { dir, home, kit, cwd, packet, reviewPacket, env, cli, promptFor };
}

test("no identity or path references", (t) => {
  const f = fixture(t);
  for (const role of roles) assert.doesNotMatch(f.promptFor(role, f.cli(role, role === "astra-review" ? f.reviewPacket : f.packet)), /GPT-|Opus|You are|\.\.\//);
});

test("git rule appears once", (t) => {
  const f = fixture(t);
  for (const role of roles) assert.equal((f.promptFor(role, f.cli(role, role === "astra-review" ? f.reviewPacket : f.packet)).match(/never run git|no commit, push/gi) ?? []).length, 1, role);
});

test("part order", (t) => {
  const f = fixture(t);
  for (const role of roles) {
    const prompt = f.promptFor(role, f.cli(role, role === "astra-review" ? f.reviewPacket : f.packet));
    const base = prompt.indexOf("If the role instructions below conflict with these rules");
    const rolePart = prompt.indexOf(role === "luna-implement" || role === "sol-implement" ? "Priorities, in order:" : role === "luna-test" ? "Act as an independent validator." : role === "astra-review" ? "Perform an independent, adversarial review." : "Investigate difficult systemic or algorithmic problems");
    const contract = prompt.indexOf(role === "astra-review" ? "verdict:" : "status:");
    const packet = prompt.indexOf("## Task packet");
    const closing = prompt.indexOf("Finish with the YAML report above as the last thing in your reply.");
    assert.ok(base < rolePart && rolePart < contract && contract < packet && packet < closing, role);
  }
});

test("result contract has no role/model keys", (t) => {
  const f = fixture(t); const prompt = f.promptFor("astra-investigate", f.cli("astra-investigate"));
  const contract = prompt.slice(prompt.indexOf("Return a YAML report"), prompt.indexOf("## Task packet"));
  assert.doesNotMatch(contract, /^\s*(role|model):/m);
});

test("report compatibility", () => {
  const task = parseWorkerReport("status: completed\nchecks_run:\n  - command: x\n    result: pass\n");
  const result = parseWorkerReport("status: partial\nchecks:\n  passed: [x]\n");
  const review = parseWorkerReport("verdict: acceptable\ncritical_findings: []\n");
  assert.equal(task.status, "completed"); assert.equal(task.checks.pass, 1);
  assert.equal(result.status, "partial"); assert.equal(result.checks.pass, 0);
  assert.equal(review, null);
});

test("creative focus passes through without inlined pipeline rules", (t) => {
  const f = fixture(t); const prompt = f.promptFor("astra-review", f.cli("astra-review", f.reviewPacket));
  assert.ok(prompt.includes("3D: topology assumptions; rig feasibility"));
  assert.doesNotMatch(prompt, /### 3D-specific|Creative Pipeline/);
});

test("freeze ignores user overrides", (t) => {
  const f = fixture(t); const override = path.join(f.home, ".claude", "orchestration", "overrides", "roles", "luna-test.md");
  fs.mkdirSync(path.dirname(override), { recursive: true }); fs.writeFileSync(override, "SENTINEL");
  const result = spawnSync(process.execPath, [path.join(REPO, "claude", "global", "test", "prompt-freeze.mjs")], { encoding: "utf8", env: { ...f.env, HOME: f.home, USERPROFILE: f.home, APPDATA: f.home } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
