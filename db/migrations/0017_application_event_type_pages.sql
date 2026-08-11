CREATE INDEX IF NOT EXISTS idx_application_events_owner_type_sequence
  ON application_events(user_id, client_id, event_type, sequence);
