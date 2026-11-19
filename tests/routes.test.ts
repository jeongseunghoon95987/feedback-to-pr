import { describe, expect, it } from "vitest";
import { app, type Env } from "../src/index";

const env = {
  DISCORD_PUBLIC_KEY: "00".repeat(32),
  DISCORD_APPLICATION_ID: "app-1",
  DISCORD_BOT_TOKEN: "bot",
} as unknown as Env;

describe("POST /discord/interactions", () => {
  it("returns 401 when the signature is missing or invalid", async () => {
    const res = await app.request(
      "/discord/interactions",
      {
        method: "POST",
        headers: { "X-Signature-Ed25519": "ab".repeat(64), "X-Signature-Timestamp": String(Math.floor(Date.now() / 1000)) },
        body: JSON.stringify({ type: 1 }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });
});
