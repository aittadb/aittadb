import { readFileSync, readdirSync } from "node:fs";
import {
  sitesMigrationJournal,
  splitSqlStatements,
} from "../build/sites-migrations.ts";
import { schemaTables } from "../db/schema";

const migrationFiles = readdirSync("db/migrations")
  .filter((fileName) => fileName.endsWith(".sql"))
  .sort();
if (migrationFiles.length === 0) {
  throw new Error("At least one checked-in D1 migration is required");
}
const sql = migrationFiles
  .map((fileName) => readFileSync(`db/migrations/${fileName}`, "utf8"))
  .join("\n");
const requiredTables = schemaTables;

for (const table of requiredTables) {
  if (!sql.includes(` ${table} `) && !sql.includes(` ${table} (`)) {
    throw new Error(`Migration is missing ${table}`);
  }
}

const statements = splitSqlStatements(sql);
if (statements.length < requiredTables.length) {
  throw new Error("Checked-in migrations do not cover required tables");
}
const journal = sitesMigrationJournal(migrationFiles);
if (journal.entries.length !== migrationFiles.length) {
  throw new Error("Sites migration journal does not cover every SQL file");
}

console.log(
  `Migration check passed for ${requiredTables.length} tables in ${migrationFiles.length} Sites-packaged migrations.`,
);
