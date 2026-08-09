ALTER TABLE audit_events ADD COLUMN actor_subject_hash TEXT CHECK (
  actor_subject_hash IS NULL OR (
    length(actor_subject_hash) = 43
    AND actor_subject_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  )
);

UPDATE audit_events
SET actor_subject_hash = CASE
      WHEN json_type(
        CASE WHEN json_valid(data_json) THEN data_json ELSE '{}' END,
        '$.actor_subject_hash'
      ) = 'text'
        AND length(json_extract(
          CASE WHEN json_valid(data_json) THEN data_json ELSE '{}' END,
          '$.actor_subject_hash'
        )) = 43
        AND json_extract(
          CASE WHEN json_valid(data_json) THEN data_json ELSE '{}' END,
          '$.actor_subject_hash'
        )
          NOT GLOB '*[^A-Za-z0-9_-]*'
      THEN json_extract(
        CASE WHEN json_valid(data_json) THEN data_json ELSE '{}' END,
        '$.actor_subject_hash'
      )
      ELSE NULL
    END,
    data_json = CASE
      WHEN json_valid(data_json)
      THEN json_remove(data_json, '$.actor_subject_hash')
      ELSE data_json
    END
WHERE json_type(
  CASE WHEN json_valid(data_json) THEN data_json ELSE '{}' END,
  '$.actor_subject_hash'
) IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_events_actor_subject
  ON audit_events(actor_subject_hash, created_at, id);
