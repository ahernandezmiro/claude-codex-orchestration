#!/usr/bin/env node
// Creates the disposable git repo used to validate the orchestration setup.
//   node claude/global/test/create-playground.mjs <target-dir>
// Refuses to touch a directory that exists and is not empty.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const target = path.resolve(process.argv[2] || "playground");
if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
  console.error(`create-playground: ${target} is not empty; delete it yourself or pick another path.`);
  process.exit(2);
}

const files = {
  "package.json": `{
  "name": "orchestration-playground",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
`,
  "src/strings.js": `export function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
`,
  "test/strings.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalize } from "../src/strings.js";

test("capitalize uppercases the first letter", () => {
  assert.equal(capitalize("hello"), "Hello");
});
`,
  "docs/slug-registry-proposal.md": `# Proposal: unique slug registry

Add \`createSlugRegistry()\` returning \`{ claim(title) }\`. \`claim\` calls \`slugify(title)\`;
if the slug is already taken it appends \`-2\`, \`-3\`, ... until free, stores it in an
in-memory \`Set\`, and returns it. The registry is a module-level singleton exported as
\`registry\` so every caller shares uniqueness. Empty slugs are stored as "".
`
};

for (const [rel, content] of Object.entries(files)) {
  const file = path.join(target, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const git = (...args) => {
  const r = spawnSync("git", ["-C", target, ...args], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
git("init", "-q");
git("add", "-A");
git("-c", "user.name=playground", "-c", "user.email=playground@local", "commit", "-qm", "Initial playground");
console.log(`Playground ready at ${target}`);
