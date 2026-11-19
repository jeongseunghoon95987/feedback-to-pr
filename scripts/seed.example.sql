-- Connects one Discord server to this deployment (self-hosted setup).
-- Copy to scripts/seed.sql, fill in the ids, then run:
--   npx wrangler d1 execute feedback-to-pr --local  --file scripts/seed.sql
--   npx wrangler d1 execute feedback-to-pr --remote --file scripts/seed.sql

INSERT INTO tenants (id, name) VALUES ('default', 'My project');

-- Right-click your server icon in Discord (Developer Mode on) -> Copy Server ID.
-- Set allowed_channel_ids to a JSON array such as '["123", "456"]' to limit channels.
INSERT INTO discord_guilds (guild_id, tenant_id, allowed_channel_ids)
VALUES ('YOUR_SERVER_ID', 'default', NULL);
