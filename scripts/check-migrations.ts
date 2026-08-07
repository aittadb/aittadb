import { readFileSync } from "node:fs";
import { schemaTables } from "../db/schema";
import { migrations } from "../src/store/migrations";

const sql = readFileSync("db/migrations/0001_initial.sql", "utf8");
const requiredTables = schemaTables;

for (const table of requiredTables) {
  if (!sql.includes(` ${table} `) && !sql.includes(` ${table} (`)) {
    throw new Error(`Migration is missing ${table}`);
  }
}

if (migrations.length < requiredTables.length) {
  throw new Error("Runtime migrations do not cover required tables");
}

console.log(`Migration check passed for ${requiredTables.length} tables.`);
