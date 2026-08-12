DROP TRIGGER IF EXISTS trg_bounded_transaction_receipts_transition;

ALTER TABLE bounded_storage_transaction_receipts
ADD COLUMN admission_class TEXT NOT NULL DEFAULT 'ordinary'
CHECK (admission_class IN ('ordinary', 'delete-reserve'));

CREATE INDEX idx_bounded_transaction_receipts_admission_scope
ON bounded_storage_transaction_receipts(
  admission_class,
  user_id,
  client_id,
  result_bytes
);

CREATE TRIGGER trg_bounded_transaction_receipts_transition
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
  OR NEW.expires_at <> OLD.expires_at
  OR NEW.admission_class <> OLD.admission_class
  OR NEW.committed_at IS NULL
  OR NEW.committed_at < NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'bounded_transaction_receipt_transition_invalid');
END;
