CREATE TABLE IF NOT EXISTS bounded_storage_transaction_receipts (
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  operation_id_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  attempt_hash TEXT NOT NULL,
  mutation_count INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  result_bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  PRIMARY KEY (user_id, client_id, operation_id_hash),
  CHECK (length(operation_id_hash) = 43 AND operation_id_hash NOT GLOB '*[^A-Za-z0-9_-]*'),
  CHECK (length(request_hash) = 43 AND request_hash NOT GLOB '*[^A-Za-z0-9_-]*'),
  CHECK (length(attempt_hash) = 43 AND attempt_hash NOT GLOB '*[^A-Za-z0-9_-]*'),
  CHECK (mutation_count BETWEEN 1 AND 25),
  CHECK (json_valid(result_json) AND json_type(result_json) = 'array'),
  CHECK (json_array_length(result_json) = mutation_count),
  CHECK (result_bytes = length(CAST(result_json AS BLOB)) AND result_bytes > 0),
  CHECK (status IN ('pending', 'committed')),
  CHECK (created_at >= 0),
  CHECK (
    (status = 'pending' AND committed_at IS NULL)
    OR (status = 'committed' AND committed_at >= created_at)
  ),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (client_id) REFERENCES oauth_clients(id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_bounded_transaction_receipts_subject_order
ON bounded_storage_transaction_receipts(user_id, client_id, created_at, operation_id_hash);

CREATE TRIGGER IF NOT EXISTS trg_bounded_transaction_receipts_active_subject_insert
BEFORE INSERT ON bounded_storage_transaction_receipts
WHEN EXISTS (SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_bounded_transaction_receipts_transition
BEFORE UPDATE ON bounded_storage_transaction_receipts
WHEN OLD.status <> 'pending'
  OR NEW.status <> 'committed'
  OR NEW.user_id <> OLD.user_id
  OR NEW.client_id <> OLD.client_id
  OR NEW.operation_id_hash <> OLD.operation_id_hash
  OR NEW.request_hash <> OLD.request_hash
  OR NEW.attempt_hash <> OLD.attempt_hash
  OR NEW.mutation_count <> OLD.mutation_count
  OR NEW.result_json <> OLD.result_json
  OR NEW.result_bytes <> OLD.result_bytes
  OR NEW.created_at <> OLD.created_at
  OR NEW.committed_at IS NULL
  OR NEW.committed_at < NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'bounded_transaction_receipt_transition_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_account_deletion_completion_bounded_receipts_clean
BEFORE UPDATE OF state ON account_deletion_jobs
WHEN OLD.state <> 'completed'
  AND NEW.state = 'completed'
  AND EXISTS (
    SELECT 1 FROM bounded_storage_transaction_receipts WHERE user_id = NEW.subject
  )
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_finalization_incomplete');
END;
