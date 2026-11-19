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

/** Recently updated open issues (pull requests excluded), offered to triage as duplicate candidates. */
export async function listOpenIssues(
  token: string,
  repo: RepoRef,
  fetchFn: typeof fetch,
): Promise<{ number: number; title: string }[]> {
  const res = await fetchFn(
    `${GITHUB_API}/repos/${repo.owner}/${repo.repo}/issues?state=open&sort=updated&direction=desc&per_page=50`,
    { headers: githubHeaders(`Bearer ${token}`) },
  );
  if (!res.ok) {
    throw new Error(`GitHub list issues failed: ${res.status} ${await res.text()}`);
  }
  const items = (await res.json()) as { number: number; title: string; pull_request?: unknown }[];
  return items.filter((item) => !item.pull_request).map(({ number, title }) => ({ number, title }));
}

export async function addIssueComment(
  token: string,
  repo: RepoRef,
  issueNumber: number,
  body: string,
  fetchFn: typeof fetch,
): Promise<void> {
  const res = await fetchFn(`${GITHUB_API}/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: { ...githubHeaders(`Bearer ${token}`), "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    throw new Error(`GitHub add comment failed: ${res.status} ${await res.text()}`);
  }
}

export function issueUrl(repo: RepoRef, issueNumber: number): string {
  return `https://github.com/${repo.owner}/${repo.repo}/issues/${issueNumber}`;
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
