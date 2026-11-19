export const GITHUB_API = "https://api.github.com";

export function githubHeaders(authorization: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: authorization,
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub rejects API requests without a User-Agent.
    "User-Agent": "feedback-to-pr",
  };
}

export interface RepoRef {
  installationId: number;
  owner: string;
  repo: string;
}

export interface IssueDraft {
  title: string;
  body: string;
  labels: string[];
}

export interface CreatedIssue {
  number: number;
  url: string;
}

export async function createIssue(
  token: string,
  repo: RepoRef,
  draft: IssueDraft,
  fetchFn: typeof fetch,
): Promise<CreatedIssue> {
  const res = await fetchFn(`${GITHUB_API}/repos/${repo.owner}/${repo.repo}/issues`, {
    method: "POST",
    headers: { ...githubHeaders(`Bearer ${token}`), "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  if (!res.ok) {
    throw new Error(`GitHub create issue failed: ${res.status} ${await res.text()}`);
  }
  const issue = (await res.json()) as { number: number; html_url: string };
  return { number: issue.number, url: issue.html_url };
}
