// Tests worktree isolation, apply/clean, and git guard behavior in codex-delegate.mjs.
//
//   node --test claude/global/test/worktree.test.mjs
//
// CLI tests stage the installed layout and use a stub companion in temporary git repos; they
// never contact Codex or touch real telemetry.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const gitRaw = (cwd, ...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const git = (cwd, ...args) => { const r = gitRaw(cwd, ...args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };

function setup(stub = `
import fs from 'node:fs'; import path from 'node:path';
const a=process.argv.slice(2), c=a[a.indexOf('--cwd')+1];
fs.writeFileSync(path.join(c,'a.txt'),'worker edit\\n'); fs.writeFileSync(path.join(c,'new.txt'),'new file\\n');
console.log('done');
`) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-worktree-test-"));
  const repo = path.join(temp, "repo"); fs.mkdirSync(repo);
  git(repo, "init", "-q"); git(repo, "config", "user.email", "test@example.test"); git(repo, "config", "user.name", "test"); git(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n"); fs.writeFileSync(path.join(repo, "untouched.txt"), "untouched base\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const kit = path.join(temp, "kit"); fs.mkdirSync(kit);
  for (const [src, dst] of [["shared", "shared"], ["codex", "codex"], ["claude/global/scripts", "scripts"], ["claude/global/config", "config"]]) fs.cpSync(path.join(REPO, src), path.join(kit, dst), { recursive: true });
  fs.rmSync(path.join(kit, "config", "models.local.json"), { force: true });
  const companion = path.join(temp, "companion.mjs"); fs.writeFileSync(companion, stub);
  const quota = path.join(temp, "quota.json"); fs.writeFileSync(quota, JSON.stringify({ usedPercent: 0, windowMinutes: 300, resetsAt: Math.floor(Date.now()/1000)+3600 }));
  const cli = (...args) => spawnSync(process.execPath, [path.join(kit, "scripts", "codex-delegate.mjs"), ...args], { encoding: "utf8", env: { ...process.env, CODEX_COMPANION: companion, CODEX_QUOTA_SNAPSHOT: quota, ORCH_TEST_MAIN: repo } });
  const packet = path.join(temp, "packet.yaml"); fs.writeFileSync(packet, "id: wt-test\nobjective: worktree test\neditable_paths: []\nacceptance_criteria: []\n");
  const runs = () => fs.readdirSync(path.join(kit, "runs")).filter(f => f.endsWith(".run.json")).map(f => JSON.parse(fs.readFileSync(path.join(kit,"runs",f),"utf8")));
  return { temp, repo, kit, cli, packet, runs };
}
const runWt = s => s.cli("run", "--role", "luna-implement", "--packet", s.packet, "--cwd", s.repo, "--worktree");

test("worktree run isolates edits, applies two files, measures touched rewrite and cleans up", () => {
  const s = setup();
  try {
    const r = runWt(s); assert.equal(r.status, 0, r.stderr);
    const [run] = s.runs(); const runPath = path.join(s.kit,"runs",`${run.run_id}.run.json`);
    assert.equal(fs.readFileSync(path.join(s.repo,"a.txt"),"utf8"),"base\n");
    assert.equal(fs.readFileSync(path.join(run.worktree.path,"a.txt"),"utf8"),"worker edit\n");
    assert.ok(run.worktree.branch.startsWith("orch/wt-test-")); assert.equal(run.git_root,run.worktree.path);
    assert.ok(run.touched_files.includes(path.join(run.worktree.path,"new.txt"))); assert.equal(run.worker_patch.files,2);
    const apply=s.cli("worktree-apply",run.run_id); assert.equal(apply.status,0,apply.stderr); assert.match(apply.stdout,/APPLIED: 2 file\(s\)/);
    assert.equal(fs.readFileSync(path.join(s.repo,"new.txt"),"utf8"),"new file\n");
    assert.equal(s.cli("worktree-apply",run.run_id).status,2);
    fs.writeFileSync(path.join(s.repo,"untouched.txt"),"unrelated change\n");
    fs.writeFileSync(path.join(s.repo,"a.txt"),"main correction\n");
    assert.equal(s.cli("assess",run.run_id,"--outcome","accepted").status,0);
    const assessed=JSON.parse(fs.readFileSync(runPath,"utf8")); assert.equal(assessed.post_worker.lines_added,1);
    assert.equal(s.cli("worktree-clean",run.run_id).status,0);
    assert.equal(fs.existsSync(assessed.worktree.path),false); assert.equal(git(s.repo,"branch","--list",assessed.worktree.branch),"");
  } finally { fs.rmSync(s.temp,{recursive:true,force:true}); }
});

test("worktree guard allows commits made in the main checkout during a run", () => {
  const s=setup(`import {spawnSync} from 'node:child_process'; import process from 'node:process'; const a=process.argv.slice(2),c=a[a.indexOf('--cwd')+1]; const r=spawnSync('git',['-C',process.env.ORCH_TEST_MAIN,'commit','--allow-empty','-qm','main'],{encoding:'utf8'}); if(r.status) throw Error(r.stderr); console.log('done');`);
  try { const r=runWt(s); assert.equal(r.status,0,r.stderr); const [run]=s.runs(); assert.equal(run.git_guard.ok,true); } finally { fs.rmSync(s.temp,{recursive:true,force:true}); }
});

test("worktree guard detects commits made inside the worker worktree", () => {
  const s=setup(`import {spawnSync} from 'node:child_process'; const a=process.argv.slice(2),c=a[a.indexOf('--cwd')+1]; const r=spawnSync('git',['-C',c,'commit','--allow-empty','-qm','worker'],{encoding:'utf8'}); if(r.status) throw Error(r.stderr); console.log('done');`);
  try { const r=runWt(s); assert.equal(r.status,3,r.stdout+r.stderr); const [run]=s.runs(); assert.equal(run.status,"git_guard_violation"); assert.ok(run.git_guard.changed.some(x=>["head","refs"].includes(x))); } finally { fs.rmSync(s.temp,{recursive:true,force:true}); }
});

test("non-worktree guard still detects commit in --cwd", () => {
  const s=setup(`import {spawnSync} from 'node:child_process'; const a=process.argv.slice(2),c=a[a.indexOf('--cwd')+1]; const r=spawnSync('git',['-C',c,'commit','--allow-empty','-qm','worker'],{encoding:'utf8'}); if(r.status) throw Error(r.stderr); console.log('done');`);
  try { const r=s.cli("run","--role","luna-implement","--packet",s.packet,"--cwd",s.repo); assert.equal(r.status,3,r.stdout+r.stderr); const [run]=s.runs(); assert.equal(run.status,"git_guard_violation"); } finally { fs.rmSync(s.temp,{recursive:true,force:true}); }
});

test("apply conflict leaves main content and applied_at unchanged", () => {
  const s=setup(); try { runWt(s); const [run]=s.runs(); fs.writeFileSync(path.join(s.repo,"a.txt"),"conflicting main edit\n"); const a=s.cli("worktree-apply",run.run_id); assert.equal(a.status,1); assert.equal(fs.readFileSync(path.join(s.repo,"a.txt"),"utf8"),"conflicting main edit\n"); assert.equal(s.runs()[0].worktree.applied_at,null); } finally { fs.rmSync(s.temp,{recursive:true,force:true}); }
});

test("clean refuses dirty unapplied worktree unless forced", () => {
  const s=setup(); try { runWt(s); let [run]=s.runs(); const refusal=s.cli("worktree-clean",run.run_id); assert.equal(refusal.status,2); assert.equal(fs.existsSync(run.worktree.path),true); const forced=s.cli("worktree-clean",run.run_id,"--force"); assert.equal(forced.status,0,forced.stderr); assert.equal(fs.existsSync(run.worktree.path),false); assert.equal(git(s.repo,"branch","--list",run.worktree.branch),""); } finally { fs.rmSync(s.temp,{recursive:true,force:true}); }
});

test("worktree requires a repository and dry-run creates no worktree or branch", () => {
  const s=setup(); const outside=path.join(s.temp,"outside"); fs.mkdirSync(outside);
  try { assert.equal(s.cli("run","--role","luna-implement","--packet",s.packet,"--cwd",outside,"--worktree").status,2); const dry=s.cli("run","--role","luna-implement","--packet",s.packet,"--cwd",s.repo,"--worktree","--dry-run"); assert.equal(dry.status,0,dry.stdout+dry.stderr); assert.equal(fs.existsSync(`${s.repo}-wt`),false); assert.equal(git(s.repo,"branch","--list","orch/*"),""); } finally { fs.rmSync(s.temp,{recursive:true,force:true}); }
});

test("background worktree collect records worktree paths and worker patch", () => {
  const s=setup(`
import fs from 'node:fs'; import path from 'node:path'; const a=process.argv.slice(2), c=a[a.indexOf('--cwd')+1];
const state=path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\\/(\\w:)/,'$1')),'job.json');
if(a.includes('--background')) { fs.writeFileSync(path.join(c,'a.txt'),'worker edit\\n'); fs.writeFileSync(state,JSON.stringify({startedAt:new Date(Date.now()-60000).toISOString(),completedAt:new Date().toISOString()})); console.log('Submitted task-abc123-xyz9'); process.exit(0); }
if(a[0]==='result') { const x=JSON.parse(fs.readFileSync(state)); console.log(JSON.stringify({storedJob:{status:'completed',startedAt:x.startedAt,completedAt:x.completedAt,result:{status:0,rawOutput:'Done.',touchedFiles:[]}}})); process.exit(0); }
`);
  try { const r=runWt({...s,cli:(...args)=>s.cli(...args,"--background")}); assert.equal(r.status,0,r.stdout+r.stderr); let [run]=s.runs(); assert.equal(run.status,"submitted_background"); const c=s.cli("collect",run.run_id); assert.equal(c.status,0,c.stdout+c.stderr); [run]=s.runs(); assert.equal(run.status,"completed"); assert.ok(run.touched_files.every(f=>f.startsWith(run.worktree.path))); assert.equal(run.worker_patch.files,1); assert.equal(run.worker_patch.lines_added,1); } finally { fs.rmSync(s.temp,{recursive:true,force:true}); }
});

test("usage worktree entries follow the normal usage formatting", () => {
  const s=setup(); try { const r=s.cli(); assert.equal(r.status,2); assert.doesNotMatch(r.stderr+r.stdout,/^\s*,/m); } finally { fs.rmSync(s.temp,{recursive:true,force:true}); }
});
