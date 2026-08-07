import { readFileSync } from "node:fs";
import { migrations } from "../src/store/migrations";

const sql = readFileSync("db/migrations/0001_initial.sql", "utf8");
const requiredTables = [
  "users",
  "oauth_clients",
  "client_redirect_uris",
  "client_scopes",
  "client_origins",
  "authorization_requests",
  "authorization_codes",
  "device_grants",
  "refresh_token_families",
  "refresh_tokens",
  "consents",
  "revoked_access_tokens",
  "audit_events",
  "rate_limit_counters",
];

for (const table of requiredTables) {
  if (!sql.includes(` ${table} `) && !sql.includes(` ${table} (`)) {
    throw new Error(`Migration is missing ${table}`);
  }
}

if (migrations.length < requiredTables.length) {
  throw new Error("Runtime migrations do not cover required tables");
}

console.log(`Migration check passed for ${requiredTables.length} tables.`);
