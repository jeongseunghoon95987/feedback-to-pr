import { Hono } from "hono";
import type { ReportJob } from "./core/types";
import type { Interaction } from "./connectors/discord/api";
import { handleInteraction } from "./connectors/discord/interactions";
import { verifyDiscordRequest } from "./connectors/discord/verify";
import { consumeBatch } from "./queue/consumer";
import { D1Store } from "./db/store";
import { createTriager, type TriageConfig, type Triager } from "./triage";
import { agentRequestFrom, verifyGitHubSignature } from "./github/webhook";
import Anthropic from "@anthropic-ai/sdk";
import { D1AgentRunStore, type AgentCompleteJob, type AgentJob } from "./agent/runs";
import { consumeAgentMessages, type AgentRunner } from "./agent/process";
import { completeAgentRun } from "./agent/complete";
import { ManagedAgentRunner, ManagedAgentSessions, type AgentSessions } from "./agent/managed";
import type { AppCredentials } from "./github/auth";

/** Reports and agent work share one queue; agent jobs carry a `kind`. */
export type QueueJob = ReportJob | AgentJob | AgentCompleteJob;

/** Default spend cap per agent session, in US cents. */
const DEFAULT_AGENT_BUDGET_CENTS = 200;

/** Session events that mean the agent stopped and its result can be collected. */
const SESSION_STOP_EVENTS = new Set(["session.status_idled", "session.status_terminated", "session.budget_reached"]);

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
  /** Server-side coding agent (Claude Managed Agents). Create the IDs with `npm run setup-agent`. */
  MANAGED_AGENT_ID?: string;
  MANAGED_ENVIRONMENT_ID?: string;
  /** Spend cap per session in US cents (default 200 = $2). */
  AGENT_BUDGET_CENTS?: string;
  /** Signing key (whsec_...) of the Managed Agents webhook endpoint registered in the Claude Console. */
  ANTHROPIC_WEBHOOK_SIGNING_KEY?: string;
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

/**
 * Claude Managed Agents webhook (registered in the Claude Console). When a
 * session stops, collect its result on the queue.
 */
app.post("/anthropic/webhook", async (c) => {
  const key = c.env.ANTHROPIC_WEBHOOK_SIGNING_KEY;
  if (!key) return c.text("webhook not configured", 503);
  const body = await c.req.text();

  let event: { data: { type: string; id: string } };
  try {
    const client = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY ?? "unused-for-verification" });
    event = client.beta.webhooks.unwrap(body, { headers: Object.fromEntries(c.req.raw.headers), key });
  } catch {
    return c.text("invalid signature", 401);
  }

  if (!SESSION_STOP_EVENTS.has(event.data.type)) return c.text("ignored", 202);
  await c.env.REPORTS_QUEUE.send({ kind: "agent_complete", sessionId: event.data.id });
  return c.text("queued", 202);
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<QueueJob>, env: Env): Promise<void> {
    // Wrap fetch: calling the Workers global as `deps.fetch(...)` throws "Illegal invocation".
    const fetchFn: typeof fetch = (input, init) => fetch(input, init);
    const github = githubCredentials(env);

    const kindOf = (job: QueueJob) => ("kind" in job ? job.kind : "report");
    const reportMessages = batch.messages.filter((m): m is Message<ReportJob> => kindOf(m.body) === "report");
    const agentMessages = batch.messages.filter((m): m is Message<AgentJob> => kindOf(m.body) === "agent");
    const completeMessages = batch.messages.filter((m): m is Message<AgentCompleteJob> => kindOf(m.body) === "agent_complete");

    if (reportMessages.length) {
      await consumeBatch({ ...batch, messages: reportMessages } as MessageBatch<ReportJob>, {
        store: new D1Store(env.DB),
        fetch: fetchFn,
        github,
        triager: triagerFrom(env),
      });
    }

    const runs = new D1AgentRunStore(env.DB);
    const sessions = agentSessionsFrom(env);
    if (agentMessages.length) {
      const runner: AgentRunner | null =
        sessions && github ? new ManagedAgentRunner({ sessions, github, fetch: fetchFn, budgetCents: budgetCents(env) }) : null;
      await consumeAgentMessages(agentMessages, { runs, fetch: fetchFn, github, runner });
    }
    for (const message of completeMessages) {
      if (!sessions || !github) {
        console.error("Agent session finished but the agent or GitHub App is not configured; dropping", message.body.sessionId);
        message.ack();
        continue;
      }
      try {
        await completeAgentRun(message.body, { runs, sessions, github, fetch: fetchFn });
        message.ack();
      } catch (error) {
        console.error("Failed to complete agent run for session", message.body.sessionId, error);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, QueueJob>;

function agentSessionsFrom(env: Env): AgentSessions | null {
  if (!env.ANTHROPIC_API_KEY || !env.MANAGED_AGENT_ID || !env.MANAGED_ENVIRONMENT_ID) return null;
  return new ManagedAgentSessions({
    apiKey: env.ANTHROPIC_API_KEY,
    agentId: env.MANAGED_AGENT_ID,
    environmentId: env.MANAGED_ENVIRONMENT_ID,
  });
}

function budgetCents(env: Env): number {
  const value = Number.parseInt(env.AGENT_BUDGET_CENTS ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_AGENT_BUDGET_CENTS;
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
