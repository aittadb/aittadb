CREATE INDEX IF NOT EXISTS idx_client_origins_origin ON client_origins(origin);
CREATE INDEX IF NOT EXISTS idx_refresh_token_families_created_at ON refresh_token_families(created_at);
CREATE INDEX IF NOT EXISTS idx_authorization_codes_request_expires ON authorization_codes(auth_request_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family_expires ON refresh_tokens(family_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_storage_records_owner_updated_key ON storage_records(user_id, client_id, updated_at DESC, key ASC);
CREATE INDEX IF NOT EXISTS idx_storage_files_owner_updated_key ON storage_files(user_id, client_id, updated_at DESC, key ASC);

-- Short user codes are bearer-equivalent transaction credentials. Keep only
-- their hashes at rest; the browser supplies the matching display value.
UPDATE device_grants SET user_code_display = '' WHERE user_code_display <> '';
