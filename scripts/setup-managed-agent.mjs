// Setup for the server-side coding agent (Claude Managed Agents).
// First run: creates the environment and the agent, then prints the IDs to store as
// MANAGED_ENVIRONMENT_ID and MANAGED_AGENT_ID. Sessions reuse the IDs.
// Later runs (MANAGED_AGENT_ID set): update the agent's instructions from
// src/agent/system-prompt.md. New sessions use the new version; running ones keep theirs.
//
// Usage: npm run setup-agent   (reads ANTHROPIC_API_KEY and the IDs from .dev.vars)

import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

const { ANTHROPIC_API_KEY: apiKey, MANAGED_AGENT_ID, MANAGED_ENVIRONMENT_ID, AGENT_MODEL } = process.env;

if (!apiKey) {
  console.error("ANTHROPIC_API_KEY must be set (see .dev.vars.example).");
  process.exit(1);
}

const client = new Anthropic({ apiKey });
const system = readFileSync(new URL("../src/agent/system-prompt.md", import.meta.url), "utf8");

if (MANAGED_AGENT_ID) {
  const agent = await client.beta.agents.update(MANAGED_AGENT_ID, { system });
  console.log(`Updated ${agent.id} to version ${agent.version}.`);
  process.exit(0);
}
if (MANAGED_ENVIRONMENT_ID) {
  console.error("MANAGED_ENVIRONMENT_ID is set without MANAGED_AGENT_ID. Remove it to create both, or set MANAGED_AGENT_ID to update the agent.");
  process.exit(1);
}

// No outbound network: the repository is mounted by the platform, and the agent
// only writes a patch for the Worker to review.
const environment = await client.beta.environments.create({
  name: "feedback-to-pr-agent",
  config: {
    type: "cloud",
    networking: { type: "limited", allow_package_managers: false, allow_mcp_servers: false },
  },
});

const agent = await client.beta.agents.create({
  name: "feedback-to-pr fixer",
  model: AGENT_MODEL || "claude-opus-5-5",
  system,
  tools: [
    {
      type: "agent_toolset_20260401",
      // The sandbox is the boundary: no network, read-only repository access, and the
      // Worker reviews the patch before anything reaches GitHub.
      default_config: { enabled: true, permission_policy: { type: "always_allow" } },
      configs: [
        { name: "web_fetch", enabled: false },
        { name: "web_search", enabled: false },
      ],
    },
  ],
});

console.log("Add these to .dev.vars (or `wrangler secret put` in production):");
console.log(`MANAGED_ENVIRONMENT_ID=${environment.id}`);
console.log(`MANAGED_AGENT_ID=${agent.id}`);
