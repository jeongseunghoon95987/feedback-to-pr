/**
 * GitHub App webhook handling. GitHub signs each delivery with HMAC-SHA256
 * over the raw body using the app's webhook secret, in X-Hub-Signature-256.
 */

export const AGENT_GO_LABEL = "agent:go";
export const AGENT_WORKING_LABEL = "agent:working";
export const AGENT_DONE_LABEL = "agent:done";
export const AGENT_FAILED_LABEL = "agent:failed";
/** Only issues filed by feedback-to-pr can be handed to the agent. */
export const AGENT_ELIGIBLE_LABEL = "source:discord";

export async function verifyGitHubSignature(secret: string, signatureHeader: string | null, body: string): Promise<boolean> {
  if (!secret || !signatureHeader?.startsWith("sha256=")) return false;
  const expected = signatureHeader.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/.test(expected)) return false;

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const actual = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(actual, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The fields of an `issues.labeled` payload this project reads. */
export interface IssuesLabeledEvent {
  action: string;
  label?: { name: string };
  issue: { number: number; labels: { name: string }[]; pull_request?: unknown };
  repository: { name: string; owner: { login: string } };
  sender: { login: string; type: string };
  installation?: { id: number };
}

export interface AgentRequest {
  owner: string;
  repo: string;
  issueNumber: number;
  requestedBy: string;
  installationId: number;
}

/**
 * Returns an agent request when the event is `agent:go` being added to an
 * eligible issue by a person; null for every other event.
 */
export function agentRequestFrom(eventName: string | null, payload: unknown): AgentRequest | null {
  if (eventName !== "issues") return null;
  const event = payload as IssuesLabeledEvent;
  if (event.action !== "labeled" || event.label?.name !== AGENT_GO_LABEL) return null;
  if (event.issue.pull_request) return null;
  if (!event.issue.labels.some((l) => l.name === AGENT_ELIGIBLE_LABEL)) return null;
  if (event.sender.type !== "User") return null; // bots and apps cannot approve agent runs
  if (!event.installation?.id) return null;
  return {
    owner: event.repository.owner.login,
    repo: event.repository.name,
    issueNumber: event.issue.number,
    requestedBy: event.sender.login,
    installationId: event.installation.id,
  };
}
