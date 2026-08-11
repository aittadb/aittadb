CREATE TABLE IF NOT EXISTS application_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (
    length(id) = 36
    AND id = lower(id)
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 15, 1) = '4'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND id NOT GLOB '*[^0-9a-f-]*'
  ),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 240),
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 240),
  event_type TEXT NOT NULL CHECK (
    length(event_type) BETWEEN 1 AND 128
    AND substr(event_type, 1, 1) GLOB '[A-Za-z0-9]'
    AND event_type NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  data_json TEXT NOT NULL CHECK (json_valid(data_json) AND json_type(data_json) = 'object'),
  data_bytes INTEGER NOT NULL CHECK (
    data_bytes >= 2
    AND data_bytes <= 65536
    AND data_bytes = length(CAST(data_json AS BLOB))
  ),
  idempotency_key_hash TEXT CHECK (
    idempotency_key_hash IS NULL OR (
      length(idempotency_key_hash) = 43
      AND idempotency_key_hash NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 43
    AND request_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  UNIQUE (user_id, client_id, idempotency_key_hash),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (client_id) REFERENCES oauth_clients(id)
);

CREATE INDEX IF NOT EXISTS idx_application_events_owner_sequence
  ON application_events(user_id, client_id, sequence);

CREATE INDEX IF NOT EXISTS idx_application_events_owner_id
  ON application_events(user_id, client_id, id);

CREATE INDEX IF NOT EXISTS idx_application_events_expires_sequence
  ON application_events(expires_at, sequence);

CREATE TRIGGER IF NOT EXISTS trg_application_events_active_subject_insert
BEFORE INSERT ON application_events
WHEN EXISTS (
  SELECT 1 FROM account_deletion_jobs WHERE subject = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_subject_inactive');
END;

CREATE TRIGGER IF NOT EXISTS trg_application_events_immutable
BEFORE UPDATE ON application_events
BEGIN
  SELECT RAISE(ABORT, 'application_event_immutable');
END;
