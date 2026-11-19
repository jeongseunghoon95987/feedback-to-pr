import { Hono } from "hono";
import type { ReportJob } from "./core/types";
import type { Interaction } from "./connectors/discord/api";
import { handleInteraction } from "./connectors/discord/interactions";
import { verifyDiscordRequest } from "./connectors/discord/verify";
import { consumeBatch } from "./queue/consumer";
import { D1Store } from "./db/store";
import { createTriager, type TriageConfig, type Triager } from "./triage";
import { agentRequestFrom, verifyGitHubSignature } from "./github/webhook";
import { D1AgentRunStore, type AgentJob } from "./agent/runs";
import { consumeAgentMessages } from "./agent/process";
import type { AppCredentials } from "./github/auth";

/** Reports and agent runs share one queue; agent jobs carry kind: "agent". */
export type QueueJob = ReportJob | AgentJob;

export interface Env extends TriageConfig {
  DB: D1Database;
  REPORTS_QUEUE: Queue<QueueJob>;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_BOT_TOKEN: string;
  /** Optional until a repository is connected. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** The GitHub App's webhook secret; required for /github/webhook. */
  GITHUB_WEBHOOK_SECRET?: string;
}

export const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("feedback-to-pr is running"));

app.post("/discord/interactions", async (c) => {
  const body = await c.req.text();
  const valid = await verifyDiscordRequest({
    publicKeyHex: c.env.DISCORD_PUBLIC_KEY,
    signatureHex: c.req.header("X-Signature-Ed25519") ?? null,
    timestamp: c.req.header("X-Signature-Timestamp") ?? null,
    body,
  });
  if (!valid) return c.text("invalid request signature", 401);

  let interaction: Interaction;
  try {
    interaction = JSON.parse(body) as Interaction;
  } catch {
    return c.text("invalid JSON", 400);
  }

  const response = await handleInteraction(interaction, {
    store: new D1Store(c.env.DB),
    enqueue: async (job) => {
      await c.env.REPORTS_QUEUE.send(job);
    },
  });
  return c.json(response);
});

/**
 * GitHub App webhook. Only `agent:go` labels on feedback-to-pr issues do
 * anything; GitHub expects a quick 2xx, so the work goes to the queue.
 */
app.post("/github/webhook", async (c) => {
  const body = await c.req.text();
  const valid = await verifyGitHubSignature(c.env.GITHUB_WEBHOOK_SECRET ?? "", c.req.header("X-Hub-Signature-256") ?? null, body);
  if (!valid) return c.text("invalid signature", 401);

  const event = c.req.header("X-GitHub-Event") ?? null;
  if (event === "ping") return c.text("pong");

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return c.text("invalid JSON", 400);
  }

  const request = agentRequestFrom(event, payload);
  if (!request) return c.text("ignored", 202);

  const runs = new D1AgentRunStore(c.env.DB);
  const tenantId = await runs.findTenantByRepo(request.owner, request.repo);
  if (!tenantId) return c.text("repository not connected", 202);

  const deliveryId = c.req.header("X-GitHub-Delivery") ?? crypto.randomUUID();
  const runId = await runs.insertRun(tenantId, deliveryId, request);
  if (runId === null) return c.text("duplicate delivery", 202);

  await c.env.REPORTS_QUEUE.send({ kind: "agent", runId });
  return c.text("queued", 202);
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<QueueJob>, env: Env): Promise<void> {
    // Wrap fetch: calling the Workers global as `deps.fetch(...)` throws "Illegal invocation".
    const fetchFn: typeof fetch = (input, init) => fetch(input, init);
    const github = githubCredentials(env);

    const agentMessages = batch.messages.filter((m): m is Message<AgentJob> => isAgentJob(m.body));
    const reportMessages = batch.messages.filter((m): m is Message<ReportJob> => !isAgentJob(m.body));

    if (reportMessages.length) {
      await consumeBatch({ ...batch, messages: reportMessages } as MessageBatch<ReportJob>, {
        store: new D1Store(env.DB),
        fetch: fetchFn,
        github,
        triager: triagerFrom(env),
      });
    }
    if (agentMessages.length) {
      await consumeAgentMessages(agentMessages, {
        runs: new D1AgentRunStore(env.DB),
        fetch: fetchFn,
        github,
        // The Managed Agents runner is added in the next step.
        runner: null,
      });
    }
  },
} satisfies ExportedHandler<Env, QueueJob>;

function isAgentJob(job: QueueJob): job is AgentJob {
  return (job as AgentJob).kind === "agent";
}

function githubCredentials(env: Env): AppCredentials | null {
  return env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY
    ? { appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY }
    : null;
}

/** A misconfigured provider turns triage off instead of failing every report. */
function triagerFrom(env: Env): Triager | null {
  try {
    return createTriager(env);
  } catch (error) {
    console.error("AI triage is disabled because of a configuration error:", error);
    return null;
  }
}
