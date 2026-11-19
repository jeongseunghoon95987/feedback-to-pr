import { Hono } from "hono";
import type { ReportJob } from "./core/types";
import type { Interaction } from "./connectors/discord/api";
import { handleInteraction } from "./connectors/discord/interactions";
import { verifyDiscordRequest } from "./connectors/discord/verify";
import { consumeBatch } from "./queue/consumer";
import { D1Store } from "./db/store";

export interface Env {
  DB: D1Database;
  REPORTS_QUEUE: Queue<ReportJob>;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_BOT_TOKEN: string;
  /** Optional until a repository is connected. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
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

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<ReportJob>, env: Env): Promise<void> {
    // Wrap fetch: calling the Workers global as `deps.fetch(...)` throws "Illegal invocation".
    await consumeBatch(batch, {
      store: new D1Store(env.DB),
      fetch: (input, init) => fetch(input, init),
      github:
        env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY
          ? { appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY }
          : null,
    });
  },
} satisfies ExportedHandler<Env, ReportJob>;
