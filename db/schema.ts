export const initialMigrationSql = String.raw`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export const schemaTables = [
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
] as const;
