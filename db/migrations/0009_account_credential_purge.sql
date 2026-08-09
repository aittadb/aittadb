ALTER TABLE revoked_access_tokens ADD COLUMN user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_authorization_codes_user_expires_code
  ON authorization_codes(user_id, expires_at, code_hash);

CREATE INDEX IF NOT EXISTS idx_authorization_requests_user_expires_id
  ON authorization_requests(user_id, expires_at, id);

CREATE INDEX IF NOT EXISTS idx_device_grants_user_expires_id
  ON device_grants(user_id, expires_at, id);

CREATE INDEX IF NOT EXISTS idx_consents_user_created_client_scope
  ON consents(user_id, created_at, client_id, scope);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_expires_id
  ON refresh_tokens(user_id, expires_at, id);

CREATE INDEX IF NOT EXISTS idx_refresh_families_user_created_id
  ON refresh_token_families(user_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_revoked_access_tokens_user_revoked_jti
  ON revoked_access_tokens(user_id, revoked_at, jti);
