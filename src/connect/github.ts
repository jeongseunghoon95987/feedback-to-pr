import { GITHUB_API, githubHeaders } from "../github/api";
import type { RepoCandidate } from "./store";

export interface GitHubOAuthApp {
  clientId: string;
  clientSecret: string;
  /** The GitHub App's URL name: github.com/apps/<slug>. */
  slug: string;
}

export function authorizeUrl(app: GitHubOAuthApp, redirectUri: string, state: string): string {
  const params = new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, state });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export function installUrl(app: GitHubOAuthApp): string {
  return `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`;
}

/** Exchanges the OAuth code for a user access token. Returns null if GitHub refuses the code. */
export async function exchangeCode(
  app: GitHubOAuthApp,
  code: string,
  redirectUri: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  const res = await fetchFn("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "feedback-to-pr" },
    body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: redirectUri }),
  });
  if (!res.ok) throw new Error(`GitHub token exchange failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token?: string; error?: string };
  return body.access_token ?? null;
}

const MAX_INSTALLATIONS = 20;
const MAX_PAGES = 3;

/**
 * Repositories the user administers on installations of this GitHub App.
 * Both endpoints only return what the token's user can access, so nothing
 * here relies on ids the browser sent.
 */
export async function listAdminRepos(userToken: string, fetchFn: typeof fetch): Promise<RepoCandidate[]> {
  const headers = githubHeaders(`Bearer ${userToken}`);
  const installationsRes = await fetchFn(`${GITHUB_API}/user/installations?per_page=${MAX_INSTALLATIONS}`, { headers });
  if (!installationsRes.ok) {
    throw new Error(`GitHub list installations failed: ${installationsRes.status} ${await installationsRes.text()}`);
  }
  const { installations } = (await installationsRes.json()) as { installations: { id: number }[] };

  const candidates: RepoCandidate[] = [];
  for (const installation of installations.slice(0, MAX_INSTALLATIONS)) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetchFn(
        `${GITHUB_API}/user/installations/${installation.id}/repositories?per_page=100&page=${page}`,
        { headers },
      );
      if (!res.ok) throw new Error(`GitHub list repositories failed: ${res.status} ${await res.text()}`);
      const { repositories } = (await res.json()) as {
        repositories: { name: string; owner: { login: string }; permissions?: { admin?: boolean } }[];
      };
      for (const repo of repositories) {
        if (repo.permissions?.admin) candidates.push({ installationId: installation.id, owner: repo.owner.login, repo: repo.name });
      }
      if (repositories.length < 100) break;
    }
  }
  return candidates;
}

/** Revokes the user token once it has been used. Best effort: tokens also expire on their own. */
export async function revokeUserToken(app: GitHubOAuthApp, userToken: string, fetchFn: typeof fetch): Promise<void> {
  const res = await fetchFn(`${GITHUB_API}/applications/${app.clientId}/token`, {
    method: "DELETE",
    headers: {
      ...githubHeaders(`Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ access_token: userToken }),
  });
  if (!res.ok && res.status !== 404) console.error("GitHub token revoke failed", res.status);
}

/** Creates a label, treating "already exists" as success. */
export async function ensureLabel(
  installationToken: string,
  repo: { owner: string; repo: string },
  label: { name: string; color: string; description: string },
  fetchFn: typeof fetch,
): Promise<void> {
  const res = await fetchFn(`${GITHUB_API}/repos/${repo.owner}/${repo.repo}/labels`, {
    method: "POST",
    headers: { ...githubHeaders(`Bearer ${installationToken}`), "Content-Type": "application/json" },
    body: JSON.stringify(label),
  });
  if (!res.ok && res.status !== 422) throw new Error(`GitHub create label failed: ${res.status} ${await res.text()}`);
}
