import { DISCORD_API } from "../connectors/discord/api";
import { t } from "../core/i18n";
import { getInstallationToken, type AppCredentials } from "../github/auth";
import { AGENT_GO_LABEL } from "../github/webhook";
import {
  authorizeUrl,
  ensureLabel,
  exchangeCode,
  installUrl,
  listAdminRepos,
  revokeUserToken,
  type GitHubOAuthApp,
} from "./github";
import { confirmPage, linkedPage, messagePage } from "./pages";
import { CONNECT_SESSION_MINUTES, type ConnectSession, type ConnectStore } from "./store";

/**
 * Browser side of /connect:
 *   /connect/start?t=<link token>  -> cookie, then GitHub sign-in
 *   /connect/github/callback       -> list repositories the user administers on our app's installations
 *   /connect/github/confirm (POST) -> link the Discord server to the chosen repository
 *   /connect/github/setup          -> GitHub's Setup URL after installing the app; signs in again
 *
 * The repository list comes only from the signed-in user's token, so ids in
 * query strings (such as the Setup URL's installation_id) are never trusted.
 */
export interface ConnectDeps {
  store: ConnectStore;
  oauth: GitHubOAuthApp;
  /** Public origin of this Worker, without a trailing slash. */
  baseUrl: string;
  github: AppCredentials | null;
  discordBotToken: string;
  fetch: typeof fetch;
}

export const CONNECT_COOKIE = "__Host-ftp_connect";

const callbackUrl = (deps: ConnectDeps) => `${deps.baseUrl}/connect/github/callback`;

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (cookie !== undefined) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function sessionCookie(value: string): string {
  return `${CONNECT_COOKIE}=${value}; Path=/; Max-Age=${CONNECT_SESSION_MINUTES * 60}; HttpOnly; Secure; SameSite=Lax`;
}

const clearCookie = `${CONNECT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

export async function startConnect(linkToken: string | undefined, deps: ConnectDeps): Promise<Response> {
  const browserToken = linkToken ? await deps.store.startSession(linkToken) : null;
  if (!browserToken) return messagePage(undefined, "expired");
  return redirect(authorizeUrl(deps.oauth, callbackUrl(deps), browserToken), sessionCookie(browserToken));
}

/** GitHub's Setup URL: after the app is installed on more repositories, sign in again to list them. */
export async function afterInstall(cookieToken: string | undefined, deps: ConnectDeps): Promise<Response> {
  const session = cookieToken ? await deps.store.findSession(cookieToken) : null;
  if (!session) return messagePage(undefined, "expired");
  return redirect(authorizeUrl(deps.oauth, callbackUrl(deps), cookieToken!));
}

export async function oauthCallback(
  cookieToken: string | undefined,
  query: { state?: string; code?: string; error?: string },
  deps: ConnectDeps,
): Promise<Response> {
  const session = cookieToken ? await deps.store.findSession(cookieToken) : null;
  // The state must match this browser's cookie, so a sign-in started elsewhere cannot be completed here.
  if (!session || !query.state || query.state !== cookieToken) return messagePage(session?.locale, "expired");
  if (query.error || !query.code) return messagePage(session.locale, "signInFailed");

  const userToken = await exchangeCode(deps.oauth, query.code, callbackUrl(deps), deps.fetch);
  if (!userToken) return messagePage(session.locale, "signInFailed");
  let candidates;
  try {
    candidates = await listAdminRepos(userToken, deps.fetch);
  } finally {
    await revokeUserToken(deps.oauth, userToken, deps.fetch).catch((error) => console.error("revoke failed", error));
  }
  await deps.store.saveCandidates(cookieToken!, candidates);

  // Nothing to pick yet: install the app first. GitHub sends the user back to the Setup URL.
  if (candidates.length === 0) return redirect(installUrl(deps.oauth));

  const guildName = await discordGuildName(session.guildId, deps);
  return confirmPage(session.locale, guildName, candidates, cookieToken!, installUrl(deps.oauth));
}

export async function confirmConnect(
  cookieToken: string | undefined,
  form: { token?: string; repo?: string },
  deps: ConnectDeps,
): Promise<Response> {
  const session = cookieToken ? await deps.store.findSession(cookieToken) : null;
  // Double submit: the form token must equal the cookie. The cookie is SameSite=Lax, so other sites cannot post with it.
  if (!session || form.token !== cookieToken) return messagePage(session?.locale, "expired");

  const wanted = form.repo?.toLowerCase();
  const candidate = session.candidates?.find((c) => `${c.owner}/${c.repo}`.toLowerCase() === wanted);
  if (!candidate) return messagePage(session.locale, "notListed");

  const guildName = await discordGuildName(session.guildId, deps);
  const result = await deps.store.link(session, candidate, guildName);
  if (result === "repo_taken") return messagePage(session.locale, "repoTaken", 409);
  if (result === "invite_used_up") return messagePage(session.locale, "inviteUsedUp", 409);
  if (result === "already_completed") return messagePage(session.locale, "expired");

  const fullName = `${candidate.owner}/${candidate.repo}`;
  await afterLink(session, candidate, fullName, deps);
  const page = linkedPage(session.locale, fullName);
  page.headers.append("Set-Cookie", clearCookie);
  return page;
}

/** Best effort: the connection is already saved, so failures here are only logged. */
async function afterLink(
  session: ConnectSession,
  repo: { installationId: number; owner: string; repo: string },
  fullName: string,
  deps: ConnectDeps,
): Promise<void> {
  if (deps.github) {
    try {
      const token = await getInstallationToken(deps.github, repo.installationId, deps.fetch);
      await ensureLabel(
        token,
        repo,
        { name: AGENT_GO_LABEL, color: "1d76db", description: "Approve the feedback-to-pr coding agent for this issue" },
        deps.fetch,
      );
    } catch (error) {
      console.error("Could not create the agent:go label", fullName, error);
    }
  }
  try {
    const res = await deps.fetch(`${DISCORD_API}/channels/${session.channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${deps.discordBotToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: t(session.locale).connectedAnnouncement(fullName), allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) console.error("Could not post the connection message", res.status);
  } catch (error) {
    console.error("Could not post the connection message", error);
  }
}

async function discordGuildName(guildId: string, deps: ConnectDeps): Promise<string> {
  try {
    const res = await deps.fetch(`${DISCORD_API}/guilds/${guildId}`, {
      headers: { Authorization: `Bot ${deps.discordBotToken}` },
    });
    if (res.ok) return ((await res.json()) as { name: string }).name;
  } catch {
    // fall through to the id
  }
  return guildId;
}
