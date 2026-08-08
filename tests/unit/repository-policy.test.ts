import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const AGENTS_PATH = new URL("../../AGENTS.md", import.meta.url);
const APP_PAGE_PATH = new URL("../../app/page.tsx", import.meta.url);
const BACKLOG_PATH = new URL("../../BACKLOG.md", import.meta.url);
const CHANGELOG_PATH = new URL("../../CHANGELOG.md", import.meta.url);
const HANDLER_PATH = new URL("../../src/handler.ts", import.meta.url);
const PLAN_PATH = new URL("../../PLAN.md", import.meta.url);
const PROTOCOL_PAGES_PATH = new URL(
  "../../src/protocol-pages.ts",
  import.meta.url,
);
const README_PATH = new URL("../../README.md", import.meta.url);
const ROADMAP_PATH = new URL("../../ROADMAP.md", import.meta.url);
const STYLE_GUIDE_PATH = new URL("../../docs/style-guide.md", import.meta.url);
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
  assert.match(policy, /PLAN is the unfinished-work queue/);
  assert.match(
    policy,
    /atomically remove the task from PLAN and append its stable identifier and unchanged full description/,
  );
});

test("PLAN contains only unfinished tasks and CHANGELOG preserves completed task history", async () => {
  const [plan, changelog] = await Promise.all([
    readFile(PLAN_PATH, "utf8"),
    readFile(CHANGELOG_PATH, "utf8"),
  ]);
  const planTasks = plan
    .split("\n")
    .filter((line) => /^- \[[ x]\] TASK-\d{3}: /i.test(line));
  const completedTasks = changelog
    .split("\n")
    .filter((line) => /^- \*\*TASK-\d{3}:\*\* /.test(line));

  assert.ok(planTasks.length > 0, "PLAN.md must contain unfinished work");
  assert.ok(
    planTasks.every((line) => /^- \[ \] TASK-\d{3}: /.test(line)),
    "PLAN.md tasks must remain unchecked until they move to CHANGELOG.md",
  );
  assert.ok(
    completedTasks.length > 0,
    "CHANGELOG.md must retain completed task history",
  );

  const identifiers = [...planTasks, ...completedTasks]
    .map((line) => Number(line.match(/TASK-(\d{3})/)?.[1]))
    .sort((left, right) => left - right);
  assert.deepEqual(
    identifiers,
    identifiers.map((_, index) => index + 1),
    "task identifiers across PLAN and CHANGELOG must remain unique and sequential",
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
    /Keep the primary worktree checkpointed: stage and make focused commits for intended changes promptly/,
    "AGENTS.md must require intended changes to be checkpointed promptly",
  );
  assert.match(
    policy,
    /Never leave intended changes loose at handoff/,
    "AGENTS.md must prohibit an uncommitted handoff",
  );
});

test("AGENTS.md isolates implementation agents from the primary worktree", async () => {
  const policy = await readFile(AGENTS_PATH, "utf8");

  assert.match(
    policy,
    /Implementation subagents MUST edit only isolated Git worktrees/,
  );
  assert.match(policy, /only reviewed, complete, validated agent commits/);
  assert.match(
    policy,
    /Coordination files such as `PLAN\.md`, `ROADMAP\.md`, `BACKLOG\.md`, and `CHANGELOG\.md` MAY be edited directly/,
  );
});

test("AGENTS.md requires evidence-based readiness confidence", async () => {
  const policy = await readFile(AGENTS_PATH, "utf8");

  assert.match(policy, /readiness confidence from `0\/100` to `100\/100`/);
  assert.match(policy, /rarely use `100\/100`/);
  assert.match(
    policy,
    /never replaces security gates or the definition of done/,
  );
  assert.match(
    policy,
    /Capture every material residual finding in `PLAN\.md`, `ROADMAP\.md`, or `BACKLOG\.md`/,
  );
});

test("public copy distinguishes project status from the current Sites dependency", async () => {
  const [agents, appPage, handler, protocolPages, readme, styleGuide] =
    await Promise.all([
      readFile(AGENTS_PATH, "utf8"),
      readFile(APP_PAGE_PATH, "utf8"),
      readFile(HANDLER_PATH, "utf8"),
      readFile(PROTOCOL_PAGES_PATH, "utf8"),
      readFile(README_PATH, "utf8"),
      readFile(STYLE_GUIDE_PATH, "utf8"),
    ]);

  for (const [name, contents] of [
    ["AGENTS.md", agents],
    ["README.md", readme],
    ["docs/style-guide.md", styleGuide],
  ] as const) {
    assert.match(contents, /third-party/i, `${name} must state project status`);
    assert.match(
      contents,
      /current implementation depends on OpenAI-hosted ChatGPT Sites/i,
      `${name} must state the current Sites dependency`,
    );
    assert.doesNotMatch(contents, /remains independent from OpenAI/i);
    assert.doesNotMatch(contents, /AittaDB is independent/i);
  }

  assert.match(appPage, /third-party application/);
  assert.match(
    appPage,
    /current implementation depends on OpenAI-hosted ChatGPT Sites/,
  );
  assert.doesNotMatch(appPage, /independent application/i);
  assert.doesNotMatch(appPage, /Persistent Events are planned/i);

  assert.match(protocolPages, /AittaDB-issued credentials are ready\./);
  assert.doesNotMatch(protocolPages, /Independent AittaDB credentials/i);
  assert.match(handler, /metadata for this AittaDB issuer\./);
  assert.doesNotMatch(handler, /independent AittaDB issuer/i);
  assert.match(
    agents,
    /belong to that AittaDB deployment, not OpenAI or ChatGPT/,
  );
  assert.doesNotMatch(agents, /AittaDB alone owns/i);

  assert.match(
    readme,
    /Persistent events and long-polling delivery as a planned capability/,
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

test("README distinguishes active delivery, completed history, roadmap, and backlog", async () => {
  const readme = await readFile(README_PATH, "utf8");

  assert.match(readme, /\[PLAN\.md\]\(PLAN\.md\)/);
  assert.match(readme, /\[CHANGELOG\.md\]\(CHANGELOG\.md\)/);
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
