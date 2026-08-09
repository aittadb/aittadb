CREATE TABLE IF NOT EXISTS storage_file_orphan_repairs (
  r2_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(r2_key) > 0),
  CHECK (length(user_id) > 0),
  CHECK (length(client_id) > 0),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_storage_file_orphan_repairs_created_at
  ON storage_file_orphan_repairs(created_at, r2_key);
