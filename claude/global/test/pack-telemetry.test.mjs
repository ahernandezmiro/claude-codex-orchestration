// Tests for the telemetry packer (scripts/pack-telemetry.mjs).
// Author: maintained with Claude Code for the frontier-model orchestration setup.
//
//   node --test claude/global/test/pack-telemetry.test.mjs
//
// Every test packs a staged orchestration dir in a temp folder; real telemetry is never read.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pack } from "../scripts/pack-telemetry.mjs";

/**
 * Input: none. Output: { root, out } — a staged orchestration dir with runs, validation runs,
 * telemetry, config and a non-data folder that must not be packed.
 */
function stage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pack-telemetry-"));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write("runs/r1.run.json", JSON.stringify({ run_id: "r1", status: "ok" }));
  write("runs/r1.prompt.md", "prompt text ".repeat(50));
  write("runs/r1.stdout.txt", "out");
  write("runs/_validation/v1.run.json", "{}");
  write("telemetry/events.jsonl", '{"e":1}\n{"e":2}\n');
  write("config/models.json", "{}");
  write("config/models.json.bak-1", "old");
  write("scripts/codex-delegate.mjs", "// kit file, not telemetry");
  write("deployed.json", "{}");
  return { root, out: path.join(root, "out.zip") };
}

/**
 * Read a zip through its central directory.
 * Input: Buffer. Output: Map<name, Buffer> of decompressed entries.
 */
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let p = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(p), 0x02014b50);
    const method = buffer.readUInt16LE(p + 10);
    const size = buffer.readUInt32LE(p + 20);
    const nameLength = buffer.readUInt16LE(p + 28);
    const local = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("utf8", p + 46, p + 46 + nameLength);
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const body = buffer.subarray(dataStart, dataStart + size);
    entries.set(name, method === 8 ? zlib.inflateRawSync(body) : body);
    p += 46 + nameLength;
  }
  return entries;
}

const baseOptions = { sources: [], allHosts: false, excludeRaw: false, excludeValidation: false, dryRun: false };

test("packs runs, telemetry, deployed.json and config JSON with a manifest; skips kit files", () => {
  const { root, out } = stage();
  const { manifest } = pack({ ...baseOptions, sources: [root], out });
  const entries = readZip(fs.readFileSync(out));
  const label = manifest.sources[0].label;
  const names = [...entries.keys()].sort();
  assert.deepEqual(names, ["manifest.json", ...[
    "config/models.json", "deployed.json", "runs/_validation/v1.run.json", "runs/r1.prompt.md",
    "runs/r1.run.json", "runs/r1.stdout.txt", "telemetry/events.jsonl"
  ].map((n) => `${label}/${n}`)].sort());
  assert.equal(entries.get(`${label}/runs/r1.prompt.md`).toString(), "prompt text ".repeat(50));
  assert.equal(manifest.sources[0].run_records, 2);
  assert.equal(manifest.sources[0].event_lines, 2);
  assert.deepEqual(JSON.parse(entries.get("manifest.json")), manifest);
});

test("--exclude-raw and --exclude-validation drop prompts/output and _validation", () => {
  const { root, out } = stage();
  const { manifest } = pack({ ...baseOptions, sources: [root], out, excludeRaw: true, excludeValidation: true });
  const label = manifest.sources[0].label;
  const names = [...readZip(fs.readFileSync(out)).keys()];
  assert.ok(names.includes(`${label}/runs/r1.run.json`));
  assert.ok(!names.some((n) => n.endsWith(".prompt.md") || n.endsWith(".stdout.txt") || n.includes("_validation")));
});

test("--dry-run writes nothing", () => {
  const { root, out } = stage();
  const result = pack({ ...baseOptions, sources: [root], out, dryRun: true });
  assert.equal(result.written, false);
  assert.equal(fs.existsSync(out), false);
});
