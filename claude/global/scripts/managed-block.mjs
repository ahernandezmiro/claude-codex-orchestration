// Id-scoped managed blocks for instruction files the kit must edit (CLAUDE.md today).
// Pure string functions; callers do the file I/O. See docs/superpowers/specs/2026-10-22-role-prompts-and-managed-blocks-design.md §3.

const LEGACY_MARKERS = {
  "claude-md": {
    begin: "<!-- BEGIN frontier-orchestration (managed by frontier_model_orchestration/claude/global/install.mjs) -->",
    end: "<!-- END frontier-orchestration -->"
  }
};

/**
 * Error raised when a managed block is invalid or ambiguous.
 * Input: problem code and 1-based line numbers. Output: an Error with `problem` and `lines`.
 */
export class ManagedBlockError extends Error {
  constructor(problem, lines = []) {
    super(`Managed block ${problem} at line(s) ${lines.join(", ")}`);
    this.name = "ManagedBlockError";
    this.problem = problem;
    this.lines = lines;
  }
}

/**
 * Add or replace one id-scoped managed block in text.
 * Input: file text, block id, and block body. Output: `{ text, changed }`.
 */
export function upsertBlock(text, id, body) {
  validateId(id);
  const lines = splitLines(text);
  const eol = detectEol(lines);
  const match = findBlock(lines, id);
  const block = renderBlock(id, body, eol);

  if (match) {
    const old = lines.slice(match.begin, match.end + 1).map((line) => line.raw).join("");
    const endEol = lines[match.end].eol;
    const replacement = `${match.begin === 0 && text.startsWith("\uFEFF") ? "\uFEFF" : ""}${block}${endEol}`;
    if (old === replacement) return { text, changed: false };
    const before = lines.slice(0, match.begin).map((line) => line.raw).join("");
    const after = lines.slice(match.end + 1).map((line) => line.raw).join("");
    return { text: `${before}${replacement}${after}`, changed: true };
  }

  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const withoutBom = bom ? text.slice(1) : text;
  if (!withoutBom.trim()) return { text: `${bom}${block}${eol}`, changed: true };

  let lastContent = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const content = i === 0 && bom ? lines[i].content.slice(1) : lines[i].content;
    if (content.trim()) { lastContent = i; break; }
  }
  const prefix = lastContent < 0 ? bom : lines.slice(0, lastContent + 1).map((line) => line.raw).join("");
  const separator = lastContent >= 0 && lines[lastContent].eol ? eol : `${eol}${eol}`;
  return { text: `${prefix}${separator}${block}${eol}`, changed: true };
}

/**
 * Remove one id-scoped managed block from text.
 * Input: file text and block id. Output: `{ text, changed }`.
 */
export function removeBlock(text, id) {
  validateId(id);
  const lines = splitLines(text);
  const match = findBlock(lines, id);
  if (!match) return { text, changed: false };

  const before = lines.slice(0, match.begin).map((line) => ({ ...line }));
  const after = lines.slice(match.end + 1).map((line) => ({ ...line }));
  const endHadEol = Boolean(lines[match.end].eol);
  const bom = text.startsWith("\uFEFF");

  if (before.length === 0) {
    while (after.length && isBlank(after[0], bom && after[0] === lines[0])) after.shift();
    if (bom && after.length) after[0].raw = `\uFEFF${after[0].raw}`;
    return { text: `${bom && !after.length ? "\uFEFF" : ""}${after.map((line) => line.raw).join("")}`, changed: true };
  }

  if (after.length === 0) {
    while (before.length && isBlank(before.at(-1), bom && before.at(-1) === lines[0])) before.pop();
    let result = before.map((line) => line.raw).join("");
    if (!endHadEol) result = result.replace(/(?:\r\n|\n)+$/, "");
    else if (result && !/(?:\r\n|\n)$/.test(result)) result += detectEol(lines);
    return { text: result, changed: true };
  }

  const trailingBlanks = [];
  while (before.length && isBlank(before.at(-1), bom && before.at(-1) === lines[0])) trailingBlanks.unshift(before.pop());
  let leadingBlanks = 0;
  while (leadingBlanks < after.length && isBlank(after[leadingBlanks], bom && after[leadingBlanks] === lines[0])) leadingBlanks += 1;
  if (trailingBlanks.length && leadingBlanks) {
    const keep = trailingBlanks[0];
    before.push(keep);
    after.splice(0, leadingBlanks);
  }
  return { text: [...before, ...after].map((line) => line.raw).join(""), changed: true };
}

/**
 * Legacy marker pairs supported by this module.
 * Input: none. Output: the id-keyed legacy marker table.
 */
export { LEGACY_MARKERS };

function validateId(id) {
  if (typeof id !== "string" || !/^[a-z0-9-]+$/.test(id)) throw new ManagedBlockError("invalid-id", []);
}

function splitLines(text) {
  const result = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match;
  while ((match = pattern.exec(text)) && (match[0] || pattern.lastIndex < text.length)) {
    result.push({ content: match[1], eol: match[2], raw: match[0] });
    if (!match[0]) break;
  }
  if (text === "") return [];
  return result;
}

function detectEol(lines) {
  return lines.find((line) => line.eol)?.eol === "\r\n" ? "\r\n" : "\n";
}

function markerContent(line, index) {
  let content = line.content;
  if (index === 0 && content.startsWith("\uFEFF")) content = content.slice(1);
  return content.replace(/\s+$/, "");
}

function markerKind(value) {
  const match = value.match(/^<!-- (BEGIN|END) orchestration-kit:([a-z0-9-]+) -->$/);
  return match ? { kind: match[1].toLowerCase(), id: match[2], legacy: false } : null;
}

function findBlock(lines, id) {
  const target = `<!-- BEGIN orchestration-kit:${id} -->`;
  const targetEnd = `<!-- END orchestration-kit:${id} -->`;
  const legacy = LEGACY_MARKERS[id];
  const begins = [];
  let active = null;
  let found = null;

  for (let index = 0; index < lines.length; index += 1) {
    const value = markerContent(lines[index], index);
    const kind = markerKind(value);
    const isLegacyBegin = Boolean(legacy && value === legacy.begin);
    const isLegacyEnd = Boolean(legacy && value === legacy.end);
    const isTargetBegin = value === target || isLegacyBegin;
    const isTargetEnd = value === targetEnd || isLegacyEnd;
    const isMarker = kind || isLegacyBegin || isLegacyEnd;

    if (active) {
      if (isTargetEnd) {
        if (found) throw new ManagedBlockError("duplicate", [found.beginLine, active.line]);
        found = { begin: active.index, end: index, beginLine: active.line };
        active = null;
      } else if (isMarker) {
        throw new ManagedBlockError("nested", [active.line, index + 1]);
      }
      continue;
    }

    if (isTargetBegin) {
      begins.push(index + 1);
      if (begins.length > 1) throw new ManagedBlockError("duplicate", [begins[0], begins[1]]);
      active = { index, line: index + 1 };
    } else if (isTargetEnd) {
      throw new ManagedBlockError("unmatched-end", [index + 1]);
    }
  }

  if (active) throw new ManagedBlockError("unmatched-begin", [active.line]);
  return found;
}

function renderBlock(id, body, eol) {
  const begin = `<!-- BEGIN orchestration-kit:${id} -->`;
  const end = `<!-- END orchestration-kit:${id} -->`;
  const cleanBody = String(body).trimEnd().replace(/\r\n|\r|\n/g, eol);
  return `${begin}${eol}${cleanBody}${eol}${end}`;
}

function isBlank(line, hasBom) {
  const content = hasBom && line.content.startsWith("\uFEFF") ? line.content.slice(1) : line.content;
  return !content.trim();
}
