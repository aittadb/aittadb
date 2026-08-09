ALTER TABLE users ADD COLUMN principal_type TEXT NOT NULL DEFAULT 'user'
  CHECK (principal_type IN ('user', 'service'));

ALTER TABLE oauth_clients ADD COLUMN client_kind TEXT NOT NULL DEFAULT 'interactive'
  CHECK (client_kind IN ('interactive', 'service'));

CREATE INDEX IF NOT EXISTS idx_users_principal_type_id
  ON users(principal_type, id);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_kind_id
  ON oauth_clients(client_kind, id);
