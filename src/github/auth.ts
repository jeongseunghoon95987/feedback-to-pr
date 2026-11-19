/**
 * GitHub App authentication: sign a short-lived JWT with the app's private
 * key, then exchange it for an installation access token (valid one hour).
 * Tokens are minted on demand and never stored.
 */

import { GITHUB_API, githubHeaders } from "./api";

/** Accepts the PEM GitHub downloads (PKCS#1) or a PKCS#8 PEM; literal "\n" sequences are allowed. */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replace(/\\n/g, "\n").trim();
  const isPkcs1 = normalized.includes("BEGIN RSA PRIVATE KEY");
  const base64 = normalized.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const pkcs8 = isPkcs1 ? wrapPkcs1InPkcs8(der) : der;
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/** Creates the app JWT. GitHub allows at most 10 minutes; iat is backdated for clock drift. */
export async function createAppJwt(appId: string, key: CryptoKey, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

export interface AppCredentials {
  appId: string;
  privateKeyPem: string;
}

export async function getInstallationToken(
  credentials: AppCredentials,
  installationId: number,
  fetchFn: typeof fetch,
): Promise<string> {
  const key = await importPrivateKey(credentials.privateKeyPem);
  const jwt = await createAppJwt(credentials.appId, key);
  const res = await fetchFn(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(`Bearer ${jwt}`),
  });
  if (!res.ok) {
    throw new Error(`GitHub installation token request failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { token: string }).token;
}

function base64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Web Crypto only imports PKCS#8. Wraps a PKCS#1 RSAPrivateKey:
 * SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { pkcs1 } }
 */
function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = [0x02, 0x01, 0x00];
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octetString = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const body = [...version, ...algorithm, ...octetString];
  return Uint8Array.from([0x30, ...derLength(body.length), ...body]);
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return [0x80 | bytes.length, ...bytes];
}
