CREATE TRIGGER IF NOT EXISTS trg_application_events_retention_bound_insert
BEFORE INSERT ON application_events
WHEN NEW.expires_at - NEW.created_at > 31536000
BEGIN
  SELECT RAISE(ABORT, 'application_event_retention_invalid');
END;
