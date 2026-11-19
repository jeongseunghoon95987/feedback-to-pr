-- Link back to the created issue, so a retried job does not create a duplicate
-- and the Discord receipt can include the URL.
ALTER TABLE reports ADD COLUMN issue_url TEXT;
