/**
 * Verifies the Ed25519 signature Discord puts on every interaction request.
 * Discord signs `timestamp + rawBody` and sends the signature and timestamp in
 * the X-Signature-Ed25519 and X-Signature-Timestamp headers. Requests that fail
 * verification must be answered with 401.
 */

/** Reject requests whose timestamp is older or newer than this, to limit replays. */
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

export interface VerifyInput {
  publicKeyHex: string;
  signatureHex: string | null;
  timestamp: string | null;
  body: string;
  /** Current time in seconds; injectable for tests. */
  nowSeconds?: number;
}

export async function verifyDiscordRequest(input: VerifyInput): Promise<boolean> {
  const { publicKeyHex, signatureHex, timestamp, body } = input;
  if (!signatureHex || !timestamp) return false;

  const ts = Number(timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_SECONDS) return false;

  const publicKey = hexToBytes(publicKeyHex, 32);
  const signature = hexToBytes(signatureHex, 64);
  if (!publicKey || !signature) return false;

  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

function hexToBytes(hex: string, expectedLength: number): Uint8Array | null {
  if (hex.length !== expectedLength * 2 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(expectedLength);
  for (let i = 0; i < expectedLength; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
