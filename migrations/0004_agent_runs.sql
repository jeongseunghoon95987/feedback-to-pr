-- One row per agent:go request.
CREATE TABLE agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- X-GitHub-Delivery; GitHub can redeliver the same event.
  delivery_id TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  requested_by TEXT NOT NULL,
  -- queued -> running -> succeeded | failed, or queued -> rejected
  status TEXT NOT NULL DEFAULT 'queued',
  session_id TEXT,
  pr_number INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX agent_runs_issue ON agent_runs (tenant_id, owner, repo, issue_number, status);
