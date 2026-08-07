import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const AGENTS_PATH = new URL("../../AGENTS.md", import.meta.url);
const BACKLOG_PATH = new URL("../../BACKLOG.md", import.meta.url);
const README_PATH = new URL("../../README.md", import.meta.url);
const ROADMAP_PATH = new URL("../../ROADMAP.md", import.meta.url);
const MAX_AGENTS_BYTES = 32_000;

test("AGENTS.md stays within the Codex instruction budget", async () => {
  const contents = await readFile(AGENTS_PATH);

  assert.ok(
    contents.byteLength < MAX_AGENTS_BYTES,
    `AGENTS.md is ${contents.byteLength} bytes; expected fewer than ${MAX_AGENTS_BYTES}`,
  );
});

test("AGENTS.md requires repository work to be captured in PLAN.md first", async () => {
  const policy = await readFile(AGENTS_PATH, "utf8");

  assert.match(
    policy,
    /Before implementing any repository-affecting user request, first capture it in root `PLAN\.md`/,
    "AGENTS.md must require recording repository work in PLAN.md before implementation",
  );
});

test("AGENTS.md requires practical parallel work on independent tasks", async () => {
  const policy = await readFile(AGENTS_PATH, "utf8");

  const parallelPolicy = policy
    .split("\n")
    .some(
      (line) =>
        /\bparallel(?:ize|ism| work)?\b/i.test(line) &&
        /\b(?:practical|possible|independent)\b/i.test(line),
    );
  assert.ok(
    parallelPolicy,
    "AGENTS.md must require practical parallel work on independent tasks",
  );
});

test("AGENTS.md requires intended changes to be committed before handoff", async () => {
  const policy = await readFile(AGENTS_PATH, "utf8");

  assert.match(
    policy,
    /After validation, commit every intended source change/,
    "AGENTS.md must require intended changes to be committed after validation",
  );
  assert.match(
    policy,
    /Do not leave intended implementation changes unstaged or uncommitted at handoff/,
    "AGENTS.md must prohibit an uncommitted handoff",
  );
});

test("ROADMAP.md is one stable flat list of unchecked future items", async () => {
  const roadmap = await readFile(ROADMAP_PATH, "utf8");
  const checkboxLines = roadmap
    .split("\n")
    .filter((line) => /^\s*- \[[ x]\]/i.test(line));

  assert.ok(checkboxLines.length > 0, "ROADMAP.md must contain future items");
  assert.ok(
    checkboxLines.every((line) => /^- \[ \] ROADMAP-\d{3}: /.test(line)),
    "roadmap items must be top-level, unchecked, and use stable identifiers",
  );
  assert.deepEqual(
    checkboxLines.map((line) => Number(line.match(/ROADMAP-(\d{3})/)?.[1])),
    checkboxLines.map((_, index) => index + 1),
    "roadmap identifiers must remain sequential",
  );
  assert.match(roadmap, /Persistent Events has no current API/);
  assert.match(roadmap, /provider capacity explicitly unknown/);
});

test("BACKLOG.md is one stable flat list of unchecked uncommitted ideas", async () => {
  const backlog = await readFile(BACKLOG_PATH, "utf8");
  const checkboxLines = backlog
    .split("\n")
    .filter((line) => /^\s*- \[[ x]\]/i.test(line));

  assert.ok(checkboxLines.length > 0, "BACKLOG.md must contain ideas");
  assert.ok(
    checkboxLines.every((line) => /^- \[ \] BACKLOG-\d{3}: /.test(line)),
    "backlog items must be top-level, unchecked, and use stable identifiers",
  );
  assert.deepEqual(
    checkboxLines.map((line) => Number(line.match(/BACKLOG-(\d{3})/)?.[1])),
    checkboxLines.map((_, index) => index + 1),
    "backlog identifiers must remain sequential",
  );
  assert.match(backlog, /not a current capability, release commitment/);
  assert.match(backlog, /must never export, import, mirror, or reveal/);
  assert.match(
    backlog,
    /BACKLOG-001: Define namespace-scoped point-in-time backup/,
  );
  assert.match(backlog, /BACKLOG-004: Define opt-in live synchronization/);
});

test("README distinguishes delivery, roadmap, and backlog documents", async () => {
  const readme = await readFile(README_PATH, "utf8");

  assert.match(readme, /\[ROADMAP\.md\]\(ROADMAP\.md\)/);
  assert.match(readme, /\[BACKLOG\.md\]\(BACKLOG\.md\)/);
  assert.match(readme, /backup and live synchronization/);
});

test("README documents unknown Sites quotas without advertising capacity", async () => {
  const readme = await readFile(README_PATH, "utf8");

  assert.match(readme, /As of August 8, 2026/);
  assert.match(readme, /no fixed numerical figures for Sites D1\/R2 capacity/);
  assert.match(
    readme,
    /100 GB[\s\S]+ChatGPT Library[\s\S]+unrelated to Sites D1\/R2/,
  );
  assert.doesNotMatch(
    readme,
    /AittaDB (?:provides|includes|supports)[^\n]*\b\d+\s*(?:MB|GB|TB)\b/i,
  );
});

test("production source trusts no undocumented Sites user ID header", async () => {
  const root = new URL("../../", import.meta.url);
  const sources = await sourceFiles(root, ["app", "src", "worker"]);
  const contents = await Promise.all(
    sources.map((path) => readFile(path, "utf8")),
  );

  assert.equal(
    contents.some((source) => source.includes("oai-authenticated-user-id")),
    false,
  );
  assert.equal(
    contents.some((source) => source.includes("TEST_AUTH_")),
    false,
    "production source must not expose a configurable mock identity",
  );
  assert.equal(
    contents.some((source) => source.includes("testIdentityProvider")),
    false,
    "the test identity provider must stay outside the production module graph",
  );
  assert.equal(
    contents.filter((source) =>
      source.includes('"oai-authenticated-user-email"'),
    ).length,
    1,
    "src/identity.ts must remain the sole production Sites identity adapter",
  );
});

async function sourceFiles(root: URL, directories: string[]): Promise<URL[]> {
  const files: URL[] = [];
  for (const directory of directories) {
    await collectSourceFiles(new URL(`${directory}/`, root), files);
  }
  return files;
}

async function collectSourceFiles(directory: URL, files: URL[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      await collectSourceFiles(new URL(`${entry.name}/`, directory), files);
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push(path);
    }
  }
}
