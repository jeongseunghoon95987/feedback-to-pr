-- Every row that belongs to a customer carries tenant_id. A self-hosted
-- install is simply a deployment with one tenant.

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Discord servers that may send reports, and the tenant they belong to.
CREATE TABLE discord_guilds (
  guild_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- JSON array of channel ids, or NULL to accept reports from every channel.
  allowed_channel_ids TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The repository issues are filed in. Only the GitHub App installation id is
-- stored; access tokens are minted per request and never persisted.
CREATE TABLE github_repos (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reports after masking. The raw text is never stored.
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  source_message_id TEXT,
  reporter_id TEXT NOT NULL,
  reported_author_id TEXT,
  title TEXT NOT NULL,
  fields TEXT NOT NULL,
  redactions INTEGER NOT NULL DEFAULT 0,
  -- queued -> received -> (triaged -> issue_created ...) in later steps
  status TEXT NOT NULL DEFAULT 'queued',
  discord_message_id TEXT,
  issue_number INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX reports_tenant_created ON reports (tenant_id, created_at);
CREATE INDEX reports_reporter_created ON reports (tenant_id, reporter_id, created_at);
