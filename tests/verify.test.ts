import { beforeAll, describe, expect, it } from "vitest";
import { verifyDiscordRequest } from "../src/connectors/discord/verify";

const toHex = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("hex");

let publicKeyHex: string;
let privateKey: CryptoKey;

async function sign(timestamp: string, body: string): Promise<string> {
  const signature = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(timestamp + body));
  return toHex(signature);
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicKeyHex = toHex((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
});

describe("verifyDiscordRequest", () => {
  const now = 1_800_000_000;
  const timestamp = String(now);
  const body = JSON.stringify({ type: 1 });

  it("accepts a correctly signed request", async () => {
    const signatureHex = await sign(timestamp, body);
    expect(await verifyDiscordRequest({ publicKeyHex, signatureHex, timestamp, body, nowSeconds: now })).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const signatureHex = await sign(timestamp, body);
    const tampered = JSON.stringify({ type: 2 });
    expect(await verifyDiscordRequest({ publicKeyHex, signatureHex, timestamp, body: tampered, nowSeconds: now })).toBe(
      false,
    );
  });

  it("rejects missing headers", async () => {
    expect(await verifyDiscordRequest({ publicKeyHex, signatureHex: null, timestamp, body, nowSeconds: now })).toBe(
      false,
    );
    expect(await verifyDiscordRequest({ publicKeyHex, signatureHex: "00", timestamp: null, body, nowSeconds: now })).toBe(
      false,
    );
  });

  it("rejects malformed hex", async () => {
    expect(
      await verifyDiscordRequest({ publicKeyHex, signatureHex: "zz".repeat(64), timestamp, body, nowSeconds: now }),
    ).toBe(false);
  });

  it("rejects old timestamps", async () => {
    const signatureHex = await sign(timestamp, body);
    expect(
      await verifyDiscordRequest({ publicKeyHex, signatureHex, timestamp, body, nowSeconds: now + 10 * 60 }),
    ).toBe(false);
  });
});
