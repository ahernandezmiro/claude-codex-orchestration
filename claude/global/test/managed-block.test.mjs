import test from "node:test";
import assert from "node:assert/strict";
import { LEGACY_MARKERS, ManagedBlockError, removeBlock, upsertBlock } from "../scripts/managed-block.mjs";

const begin = (id) => `<!-- BEGIN orchestration-kit:${id} -->`;
const end = (id) => `<!-- END orchestration-kit:${id} -->`;
const block = (id, body) => `${begin(id)}\n${body}\n${end(id)}`;

test("empty and whitespace-only text get block + EOL", () => {
  const expected = `${block("x", "B")}\n`;
  assert.equal(upsertBlock("", "x", "B").text, expected);
  assert.equal(upsertBlock("  \n\n", "x", "B").text, expected);
});

test("append trims trailing blank lines to one separator", () => {
  const expected = `a\n\n${block("x", "B")}\n`;
  assert.equal(upsertBlock("a\n\n\n", "x", "B").text, expected);
  assert.equal(upsertBlock("a", "x", "B").text, expected);
});

test("replace keeps outside bytes", () => {
  for (const input of [
    `${block("x", "old")}\ntail\n`,
    `head\n${block("x", "old")}\ntail\n`,
    `head\n${block("x", "old")}`
  ]) {
    const start = input.indexOf(begin("x"));
    const after = input.indexOf(end("x")) + end("x").length;
    const output = upsertBlock(input, "x", "new").text;
    const newStart = output.indexOf(begin("x"));
    const newAfter = output.indexOf(end("x")) + end("x").length;
    assert.equal(output.slice(0, newStart), input.slice(0, start));
    assert.equal(output.slice(newAfter), input.slice(after));
  }
});

test("legacy pair migrates to new markers", () => {
  const legacy = LEGACY_MARKERS["claude-md"];
  const input = `lead\n${legacy.begin}\nold body\n${legacy.end}\ntail\n`;
  const result = upsertBlock(input, "claude-md", "new body");
  assert.equal(result.changed, true);
  assert.equal(result.text.includes("frontier-orchestration"), false);
  assert.equal(result.text.split(begin("claude-md")).length - 1, 1);
  assert.equal(result.text.split(end("claude-md")).length - 1, 1);
});

test("legacy lookalike is plain text", () => {
  const input = "<!-- BEGIN frontier-orchestration-x -->\n";
  const result = upsertBlock(input, "claude-md", "body");
  assert.equal(result.text.startsWith(input), true);
  assert.equal(result.changed, true);
});

test("unmatched begin", () => {
  assertMalformedBoth("head\n<!-- BEGIN orchestration-kit:x -->\n", "x", "unmatched-begin", [2]);
});

test("unmatched or early end", () => {
  assertMalformedBoth(`${end("x")}\n`, "x", "unmatched-end", [1]);
  assertMalformedBoth(`${end("x")}\n${begin("x")}\n`, "x", "unmatched-end", [1]);
});

test("two blocks rejected", () => {
  assertMalformedBoth(`${block("x", "one")}\n${block("x", "two")}\n`, "x", "duplicate", [1, 4]);
  const legacy = LEGACY_MARKERS["claude-md"];
  assertMalformedBoth(`${legacy.begin}\nold\n${legacy.end}\n${block("claude-md", "new")}\n`, "claude-md", "duplicate", [1, 4]);
});

test("nested marker rejected", () => {
  const input = `${begin("x")}\n${begin("y")}\n${end("x")}\n`;
  assertMalformedBoth(input, "x", "nested", [1, 2]);
});

test("other id is untouched", () => {
  const other = `${block("y", "keep")}`;
  const input = `${other}\n`;
  const result = upsertBlock(input, "x", "add");
  assert.equal(result.text.startsWith(input), true);
  assert.equal(result.text.slice(0, other.length), other);
});

test("CRLF, mixed EOL and BOM preserved", () => {
  const input = "\uFEFFa\r\nb\n";
  const result = upsertBlock(input, "x", "line 1\nline 2\r\n");
  assert.equal(result.text.startsWith("\uFEFFa\r\nb\n\r\n"), true);
  assert.equal(result.text.includes(`${begin("x")}\r\nline 1\r\nline 2\r\n${end("x")}\r\n`), true);
  assert.equal(result.text.includes("b\n"), true);
  const bomBlock = `\uFEFF${block("claude-md", "old")}\n`;
  assert.equal(upsertBlock(bomBlock, "claude-md", "new").text.startsWith("\uFEFF"), true);
  assert.equal(removeBlock(bomBlock, "claude-md").text, "\uFEFF");
  assert.equal(removeBlock(`\uFEFF${block("x", "old")}\n\nrest\n`, "x").text, "\uFEFFrest\n");
});

test("identical body is a no-op", () => {
  const input = `${block("x", "same")}\n`;
  const result = upsertBlock(input, "x", "same  \n");
  assert.equal(result.changed, false);
  assert.equal(result.text, input);
});

test("remove start/middle/end and no-op and malformed", () => {
  assert.deepEqual(removeBlock(`${block("x", "body")}\nnext\n`, "x"), { text: "next\n", changed: true });
  assert.deepEqual(removeBlock(`head\n\n${block("x", "body")}\n\ntail\n`, "x"), { text: "head\n\ntail\n", changed: true });
  assert.deepEqual(removeBlock(`head\n\n${block("x", "body")}`, "x"), { text: "head", changed: true });
  assert.deepEqual(removeBlock("unmanaged\n", "x"), { text: "unmanaged\n", changed: false });
  for (const [input, problem] of [[`${begin("x")}\n`, "unmatched-begin"], [`${end("x")}\n`, "unmatched-end"], [`${block("x", "a")}\n${block("x", "b")}\n`, "duplicate"], [`${begin("x")}\n${begin("y")}\n${end("x")}\n`, "nested"]]) {
    assert.throws(() => removeBlock(input, "x"), (error) => error instanceof ManagedBlockError && error.problem === problem);
  }
});

test("inline marker text is not a marker", () => {
  const input = "see `<!-- BEGIN orchestration-kit:x -->` here\n";
  const result = upsertBlock(input, "x", "body");
  assert.equal(result.changed, true);
  assert.equal(result.text.startsWith(input), true);
});

test("invalid id is rejected", () => {
  for (const operation of [() => upsertBlock("", "Bad_ID", "body"), () => removeBlock("", "Bad_ID")]) {
    assert.throws(operation, (error) => error instanceof ManagedBlockError && error.problem === "invalid-id");
  }
});

function assertMalformedBoth(input, id, problem, lines) {
  for (const operation of [() => upsertBlock(input, id, "replacement"), () => removeBlock(input, id)]) {
    assert.throws(operation, (error) => {
      assert.ok(error instanceof ManagedBlockError);
      assert.equal(error.problem, problem);
      assert.deepEqual(error.lines, lines);
      return true;
    });
  }
}
