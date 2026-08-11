-- Keep the existing completion guard intact and add the event table as one
-- independent condition. Migration 0013 already rejects new event inserts as
-- soon as any deletion job exists.
CREATE TRIGGER IF NOT EXISTS trg_account_deletion_completion_events_clean
BEFORE UPDATE OF state ON account_deletion_jobs
WHEN OLD.state <> 'completed'
  AND NEW.state = 'completed'
  AND EXISTS (SELECT 1 FROM application_events WHERE user_id = NEW.subject)
BEGIN
  SELECT RAISE(ABORT, 'account_deletion_finalization_incomplete');
END;
