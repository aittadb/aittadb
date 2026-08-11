import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const AGENTS_PATH = new URL("../../AGENTS.md", import.meta.url);
const APP_PAGE_PATH = new URL("../../app/page.tsx", import.meta.url);
const BACKLOG_PATH = new URL("../../BACKLOG.md", import.meta.url);
const CHANGELOG_PATH = new URL("../../CHANGELOG.md", import.meta.url);
const DEPLOYMENT_PATH = new URL("../../docs/deployment.md", import.meta.url);
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
    /Before repository-affecting work, first add or amend an unchecked root `PLAN\.md` task/,
    "AGENTS.md must require recording repository work in PLAN.md before implementation",
  );
  assert.match(policy, /PLAN is one flat unfinished `TASK-NNN` queue/);
  assert.match(
    policy,
    /After DoD, remove the task from PLAN and append its unchanged description to CHANGELOG/,
  );
});

test("AGENTS.md prohibits umbrella plan tasks", async () => {
  const policy = await readFile(AGENTS_PATH, "utf8");

  assert.match(
    policy,
    /Each item MUST own exactly one server primitive or one narrowly bounded operational proof/,
  );
  assert.match(
    policy,
    /Never combine independent resources, methods, controls, migrations, or live matrices in one task/,
  );
  assert.match(policy, /Broad requests first create a decomposition task/);
  assert.match(policy, /retire the umbrella[\s\S]+without claiming delivery/);
  assert.match(
    policy,
    /A Sites-only acceptance task proves one named behavior against one exact deployment/,
  );
});

test("PLAN is an optional unfinished queue and CHANGELOG preserves completed task history", async () => {
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

  assert.match(plan, /^# AittaDB Implementation Plan$/m);
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

test("PLAN tasks have explicit bounded definitions of done", async () => {
  const plan = await readFile(PLAN_PATH, "utf8");
  const tasks = plan
    .split("\n")
    .filter((line) => /^- \[ \] TASK-\d{3}: /.test(line));

  assert.ok(
    tasks.every((line) => line.includes(". DoD:")),
    "every PLAN task must state an explicit DoD",
  );
  assert.ok(
    tasks.every((line) => line.length < 1_200),
    "PLAN task lines must stay small enough to remain independently reviewable",
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

test("AGENTS.md keeps AittaDB primitive-first and inside its server boundary", async () => {
  const policy = await readFile(AGENTS_PATH, "utf8");

  assert.match(
    policy,
    /general-purpose hosted database server and application-backend service/,
  );
  assert.match(policy, /small, independent, reusable primitives/);
  assert.match(
    policy,
    /Client SDKs, libraries, application integrations, and provider adapters belong in separate repositories/,
  );
  assert.match(policy, /Application workflows[\s\S]+belong outside AittaDB/);
  assert.match(
    policy,
    /Before adding work, answer:[\s\S]+every new abstraction needed now/,
  );
  assert.match(
    policy,
    /mainly an application feature, client implementation, provider integration, or speculative extension system, keep it outside this repository/,
  );
  assert.match(
    policy,
    /If a request conflicts, stop before implementation[\s\S]+smallest general-purpose enabling primitive/,
  );
  assert.match(
    policy,
    /Describe the primitive, not its motivating application/,
  );
  assert.doesNotMatch(policy, /MVP branch is `codex\/initial-implementation`/);
});

test("public copy distinguishes licensing from the current Sites dependency", async () => {
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
    assert.match(contents, /source-available/i, `${name} must state licensing`);
    assert.match(contents, /FSL-1\.1-MIT/i);
    assert.match(contents, /available commercially/i);
    assert.match(
      contents,
      /current implementation depends on OpenAI-hosted ChatGPT Sites/i,
      `${name} must state the current Sites dependency`,
    );
    assert.doesNotMatch(contents, /third-party, non-official project/i);
    assert.doesNotMatch(contents, /remains independent from OpenAI/i);
    assert.doesNotMatch(contents, /AittaDB is independent/i);
  }

  assert.match(appPage, /Source-available under FSL-1\.1-MIT/);
  assert.match(
    appPage,
    /Identity, sessions, JSON data, and files for connected applications/,
  );
  assert.match(
    appPage,
    /ChatGPT provides browser sign-in[\s\S]+inside ChatGPT Sites/,
  );
  assert.match(appPage, /creates a separate local identity/);
  assert.match(appPage, /issues[\s\S]+its own credentials/);
  assert.match(appPage, /never receives or forwards ChatGPT credentials/);
  assert.doesNotMatch(appPage, /AittaDB runs on OpenAI-hosted/);
  assert.doesNotMatch(appPage, /ChatGPT OAuth/i);
  assert.doesNotMatch(appPage, /third-party, non-official project/);
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
    /Feature-gated bounded reads of persistent immutable application events/,
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

test("public Sites access remains an explicit safe operating posture", async () => {
  const [agents, deployment, readme] = await Promise.all([
    readFile(AGENTS_PATH, "utf8"),
    readFile(DEPLOYMENT_PATH, "utf8"),
    readFile(README_PATH, "utf8"),
  ]);

  assert.match(agents, /Assume public Sites access/);
  assert.match(agents, /subject-scoped, authorized, and quota-bounded/);
  assert.match(readme, /remain safe when its Sites access mode is public/);
  assert.match(readme, /does not expose another user's namespace/);
  assert.match(deployment, /Public mode permits any ChatGPT user/);
  assert.match(
    deployment,
    /two ordinary signed-in users receive distinct empty namespaces/,
  );
  assert.match(
    deployment,
    /Public access never substitutes for these server-side controls/,
  );
});

test("README starts with a short private-first @Sites install prompt", async () => {
  const readme = await readFile(README_PATH, "utf8");
  const promptStart = readme.indexOf("@Sites Create a new private AittaDB");
  const licensingStart = readme.indexOf("## Licensing");

  assert.ok(promptStart >= 0, "README must include a copy-ready @Sites prompt");
  assert.ok(
    promptStart < licensingStart,
    "the deployment prompt must remain near the start of README",
  );
  assert.match(readme, /https:\/\/github\.com\/aittadb\/aittadb/);
  assert.match(readme, /use fresh storage and secrets for this instance/);
  assert.match(readme, /validate it, and deploy it privately/);
  assert.match(
    readme,
    /Do not reuse another AittaDB instance's data or secrets/,
  );
  assert.match(readme, /ask me before making it public/);
  assert.match(readme, /\[deployment guide\]\(docs\/deployment\.md\)/);
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
