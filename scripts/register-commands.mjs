// Registers the /bug slash command and the "Report as bug" message command.
// Usage: npm run register-commands   (reads .dev.vars)
//
// With DISCORD_DEV_GUILD_ID set, commands are registered to that one server and
// show up immediately. Without it they are registered globally.

import commands from "../src/connectors/discord/commands.json" with { type: "json" };

const { DISCORD_APPLICATION_ID: appId, DISCORD_BOT_TOKEN: token, DISCORD_DEV_GUILD_ID: guildId } = process.env;

if (!appId || !token) {
  console.error("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN must be set (see .dev.vars.example).");
  process.exit(1);
}

const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;

// PUT replaces the full command list, so removed commands are cleaned up too.
const res = await fetch(url, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error(`Failed to register commands: ${res.status} ${await res.text()}`);
  process.exit(1);
}

const registered = await res.json();
console.log(`Registered ${registered.length} command(s) ${guildId ? `to server ${guildId}` : "globally"}:`);
for (const command of registered) console.log(`  - ${command.name} (type ${command.type})`);
