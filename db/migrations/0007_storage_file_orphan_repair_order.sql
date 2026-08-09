CREATE INDEX IF NOT EXISTS idx_storage_file_orphan_repairs_updated_at
  ON storage_file_orphan_repairs(updated_at, created_at, r2_key);

CREATE INDEX IF NOT EXISTS idx_storage_files_r2_key
  ON storage_files(r2_key);
