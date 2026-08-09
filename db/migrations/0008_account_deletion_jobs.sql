CREATE TABLE IF NOT EXISTS account_deletion_jobs (
  subject TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'retryable', 'completed')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  available_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (length(subject) > 0),
  CHECK (updated_at >= created_at),
  CHECK (
    (state = 'pending' AND attempt = 0 AND available_at IS NOT NULL AND completed_at IS NULL)
    OR (state IN ('running', 'retryable') AND attempt > 0 AND available_at IS NOT NULL AND completed_at IS NULL)
    OR (state = 'completed' AND attempt > 0 AND available_at IS NULL AND completed_at IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_account_deletion_jobs_claimable
  ON account_deletion_jobs(available_at, created_at, subject)
  WHERE state IN ('pending', 'running', 'retryable');
