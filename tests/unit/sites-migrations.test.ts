import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitSitesMigrations,
  sitesMigrationJournal,
  splitSqlStatements,
} from "../../build/sites-migrations.ts";

test("Sites migration packaging preserves complete SQL statements and ordering", () => {
  const statements = splitSqlStatements(`
    CREATE TABLE example (value TEXT DEFAULT ';');
    -- A semicolon in a comment does not split; here.
    INSERT INTO example (value) VALUES ('it''s; safe');
  `);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /DEFAULT ';'/);
  assert.match(statements[1], /'it''s; safe'/);

  const journal = sitesMigrationJournal([
    "0001_initial.sql",
    "0002_browser_session_client.sql",
  ]);
  assert.deepEqual(
    journal.entries.map((entry) => ({ idx: entry.idx, tag: entry.tag })),
    [
      { idx: 0, tag: "0001_initial" },
      { idx: 1, tag: "0002_browser_session_client" },
    ],
  );
  assert.ok(journal.entries.every((entry) => entry.breakpoints));
});

test("Sites migration packaging rejects unterminated SQL", () => {
  assert.throws(
    () => splitSqlStatements("CREATE TABLE missing (id TEXT)"),
    /must end with a semicolon/,
  );
  assert.throws(
    () => splitSqlStatements("CREATE TABLE missing (value TEXT DEFAULT 'x);"),
    /Unterminated SQL syntax/,
  );
});

test("Sites migration packaging removes stale generated migrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "aittadb-migrations-"));
  const source = join(root, "source");
  const output = join(root, "output");
  try {
    await mkdir(source);
    await mkdir(output);
    await writeFile(join(source, "0001_test.sql"), "SELECT 1;\n");
    await writeFile(join(output, "stale.sql"), "SELECT 0;\n");
    await emitSitesMigrations(source, output);
    assert.deepEqual((await readdir(output)).sort(), ["0001_test.sql", "meta"]);
    assert.match(
      await readFile(join(output, "0001_test.sql"), "utf8"),
      /^SELECT 1;$/m,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
