-- AI triage result (JSON), kept so a retried job does not call the model again.
ALTER TABLE reports ADD COLUMN triage TEXT;
