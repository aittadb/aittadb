CREATE TABLE IF NOT EXISTS storage_file_write_fences (
  r2_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (length(r2_key) > 0),
  CHECK (length(user_id) > 0),
  CHECK (length(client_id) > 0),
  CHECK (expires_at > created_at),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (client_id) REFERENCES oauth_clients(id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_storage_file_write_fences_expiry
  ON storage_file_write_fences(expires_at, r2_key);

CREATE INDEX IF NOT EXISTS idx_storage_file_write_fences_user
  ON storage_file_write_fences(user_id, expires_at, r2_key);

CREATE INDEX IF NOT EXISTS idx_admin_operation_submissions_user
  ON admin_operation_submissions(user_id, expires_at, token_hash);

CREATE INDEX IF NOT EXISTS idx_storage_file_orphan_repairs_user
  ON storage_file_orphan_repairs(user_id, updated_at, created_at, r2_key);

-- A request may have passed the domain gate before deletion started. These
-- triggers make the durable ownership assignment itself fail closed.
CREATE TRIGGER IF NOT EXISTS trg_authorization_requests_active_subject_insert
BEFORE INSERT ON authorization_requests
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_authorization_requests_active_subject_update
BEFORE UPDATE OF user_id ON authorization_requests
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_authorization_codes_active_subject_insert
BEFORE INSERT ON authorization_codes
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_authorization_codes_active_subject_update
BEFORE UPDATE OF user_id ON authorization_codes
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_device_grants_active_subject_insert
BEFORE INSERT ON device_grants
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_device_grants_active_subject_update
BEFORE UPDATE OF user_id ON device_grants
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_refresh_families_active_subject_insert
BEFORE INSERT ON refresh_token_families
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_refresh_families_active_subject_update
BEFORE UPDATE OF user_id ON refresh_token_families
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_refresh_tokens_active_subject_insert
BEFORE INSERT ON refresh_tokens
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_refresh_tokens_active_subject_update
BEFORE UPDATE OF user_id ON refresh_tokens
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_consents_active_subject_insert
BEFORE INSERT ON consents
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_consents_active_subject_update
BEFORE UPDATE OF user_id ON consents
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_revoked_tokens_active_subject_insert
BEFORE INSERT ON revoked_access_tokens
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_revoked_tokens_active_subject_update
BEFORE UPDATE OF user_id ON revoked_access_tokens
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_storage_records_active_subject_insert
BEFORE INSERT ON storage_records
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_storage_records_active_subject_update
BEFORE UPDATE OF user_id ON storage_records
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_storage_files_active_subject_insert
BEFORE INSERT ON storage_files
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_storage_files_active_subject_update
BEFORE UPDATE OF user_id ON storage_files
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_submissions_active_subject_insert
BEFORE INSERT ON admin_operation_submissions
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_submissions_active_subject_update
BEFORE UPDATE OF user_id ON admin_operation_submissions
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_file_write_fences_active_subject_insert
BEFORE INSERT ON storage_file_write_fences
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_file_write_fences_active_subject_update
BEFORE UPDATE OF user_id ON storage_file_write_fences
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

-- A terminal tombstone is valid only after the user and every subject-owned
-- row are gone. This keeps future repository code from bypassing finalization.
CREATE TRIGGER IF NOT EXISTS trg_account_deletion_completion_insert
BEFORE INSERT ON account_deletion_jobs
WHEN NEW.state = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_finalization_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_account_deletion_completion_clean
BEFORE UPDATE OF state ON account_deletion_jobs
WHEN OLD.state <> 'completed' AND NEW.state = 'completed' AND (
  EXISTS (SELECT 1 FROM users WHERE id = NEW.subject)
  OR EXISTS (SELECT 1 FROM authorization_requests WHERE user_id = NEW.subject)
  OR EXISTS (SELECT 1 FROM authorization_codes WHERE user_id = NEW.subject)
  OR EXISTS (SELECT 1 FROM device_grants WHERE user_id = NEW.subject)
  OR EXISTS (SELECT 1 FROM refresh_token_families WHERE user_id = NEW.subject)
  OR EXISTS (SELECT 1 FROM refresh_tokens WHERE user_id = NEW.subject)
  OR EXISTS (SELECT 1 FROM consents WHERE user_id = NEW.subject)
  OR EXISTS (SELECT 1 FROM revoked_access_tokens WHERE user_id = NEW.subject)
  OR EXISTS (SELECT 1 FROM storage_records WHERE user_id = NEW.subject)
  OR EXISTS (SELECT 1 FROM storage_files WHERE user_id = NEW.subject)
  OR EXISTS (SELECT 1 FROM storage_file_write_fences WHERE user_id = NEW.subject)
  OR EXISTS (SELECT 1 FROM storage_file_orphan_repairs WHERE user_id = NEW.subject)
  OR EXISTS (SELECT 1 FROM admin_operation_submissions WHERE user_id = NEW.subject)
)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_finalization_incomplete');
END;

-- Repair rows remain writable while deletion is active so R2 compensation can
-- converge. A completed tombstone forbids new subject-attributed repair state.
CREATE TRIGGER IF NOT EXISTS trg_file_repairs_deleted_subject_insert
BEFORE INSERT ON storage_file_orphan_repairs
WHEN EXISTS (
  SELECT 1 FROM account_deletion_jobs
  WHERE subject = NEW.user_id AND state = 'completed'
)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_file_repairs_deleted_subject_update
BEFORE UPDATE OF user_id ON storage_file_orphan_repairs
WHEN EXISTS (
  SELECT 1 FROM account_deletion_jobs
  WHERE subject = NEW.user_id AND state = 'completed'
)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;
