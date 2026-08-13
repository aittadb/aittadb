DROP TRIGGER IF EXISTS trg_bounded_transaction_receipts_transition;

ALTER TABLE bounded_storage_transaction_receipts
ADD COLUMN collection_names_json TEXT NOT NULL DEFAULT '[]'
CHECK (json_valid(collection_names_json) AND json_type(collection_names_json) = 'array');

CREATE TABLE IF NOT EXISTS bounded_storage_transaction_receipt_collections (
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  operation_id_hash TEXT NOT NULL,
  collection TEXT NOT NULL,
  PRIMARY KEY (user_id, client_id, operation_id_hash, collection),
  FOREIGN KEY (user_id, client_id, operation_id_hash)
    REFERENCES bounded_storage_transaction_receipts(user_id, client_id, operation_id_hash)
    ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_bounded_receipt_collections_namespace
ON bounded_storage_transaction_receipt_collections(
  user_id, client_id, collection, operation_id_hash
);

INSERT OR IGNORE INTO bounded_storage_transaction_receipt_collections (
  user_id, client_id, operation_id_hash, collection
)
SELECT receipt.user_id, receipt.client_id, receipt.operation_id_hash, collection_name.value
FROM bounded_storage_transaction_receipts AS receipt
JOIN json_each(receipt.collection_names_json) AS collection_name
WHERE typeof(collection_name.value) = 'text';

-- Older receipts did not retain collection names. Backfill only when every
-- ordered result entry carries a normal record key; null delete/check results
-- stay deliberately unassociated and cannot be removed by maintenance.
INSERT OR IGNORE INTO bounded_storage_transaction_receipt_collections (
  user_id, client_id, operation_id_hash, collection
)
SELECT receipt.user_id, receipt.client_id, receipt.operation_id_hash,
  json_extract(result_entry.value, '$.key.collection')
FROM bounded_storage_transaction_receipts AS receipt
JOIN json_each(receipt.result_json) AS result_entry
WHERE json_type(result_entry.value, '$.key.collection') = 'text'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(receipt.result_json) AS candidate
    WHERE COALESCE(json_type(candidate.value, '$.key.collection'), '') <> 'text'
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
  OR NEW.collection_names_json <> OLD.collection_names_json
  OR NEW.committed_at IS NULL
  OR NEW.committed_at < NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'bounded_transaction_receipt_transition_invalid');
END;
