CREATE TABLE IF NOT EXISTS bounded_storage_records (
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  value_json TEXT NOT NULL,
  value_bytes INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, client_id, collection, record_id),
  CHECK (collection GLOB '[a-z]*'),
  CHECK (collection NOT GLOB '*[^a-z0-9-]*'),
  CHECK (length(collection) BETWEEN 1 AND 64),
  CHECK (record_id GLOB '[A-Za-z0-9]*'),
  CHECK (record_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  CHECK (length(record_id) = 1 OR substr(record_id, -1, 1) GLOB '[A-Za-z0-9]'),
  CHECK (length(record_id) BETWEEN 1 AND 128),
  CHECK (json_valid(value_json)),
  CHECK (json_type(value_json) = 'object'),
  CHECK (value_bytes = length(CAST(value_json AS BLOB))),
  CHECK (revision >= 1),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (client_id) REFERENCES oauth_clients(id)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS trg_bounded_records_active_subject_insert
BEFORE INSERT ON bounded_storage_records
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_bounded_records_active_subject_update
BEFORE UPDATE OF user_id ON bounded_storage_records
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_account_deletion_completion_bounded_records_clean
BEFORE UPDATE OF state ON account_deletion_jobs
WHEN OLD.state <> 'completed'
  AND NEW.state = 'completed'
  AND EXISTS (
    SELECT 1 FROM bounded_storage_records WHERE user_id = NEW.subject
  )
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_finalization_incomplete');
END;
