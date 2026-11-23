-- Self-service onboarding: a server admin runs /connect in Discord, signs in to
-- GitHub, and picks a repository the GitHub App is installed on.

-- One repository belongs to at most one tenant, so reports from one server can
-- never be filed in a repository another server connected.
CREATE UNIQUE INDEX github_repos_owner_repo ON github_repos (lower(owner), lower(repo));
CREATE INDEX github_repos_installation ON github_repos (installation_id);

CREATE TABLE connect_sessions (
  -- Random token in the link the bot sends. Usable once, to start the flow.
  link_token TEXT PRIMARY KEY,
  -- Random token set as a cookie when the link is opened; also the OAuth state.
  browser_token TEXT UNIQUE,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  invite_code TEXT,
  -- JSON list of {installationId, owner, repo} the signed-in GitHub user administers.
  candidates TEXT,
  expires_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Invite codes for the closed beta (only checked when CONNECT_INVITE_REQUIRED=true).
CREATE TABLE invite_codes (
  code TEXT PRIMARY KEY,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
