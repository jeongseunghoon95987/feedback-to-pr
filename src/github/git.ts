/**
 * GitHub Git Data and pull request calls used to turn a reviewed patch into a
 * branch and a draft PR, entirely through the API (no git checkout).
 */

import { GITHUB_API, githubHeaders, type RepoRef } from "./api";

type Repo = Pick<RepoRef, "owner" | "repo">;

async function call<T>(token: string, fetchFn: typeof fetch, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetchFn(`${GITHUB_API}${path}`, {
    method,
    headers: { ...githubHeaders(`Bearer ${token}`), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const base = (r: Repo) => `/repos/${r.owner}/${r.repo}`;

export async function getDefaultBranch(token: string, repo: Repo, fetchFn: typeof fetch): Promise<string> {
  return (await call<{ default_branch: string }>(token, fetchFn, "GET", base(repo))).default_branch;
}

export interface BranchHead {
  commitSha: string;
  treeSha: string;
}

export async function getBranchHead(token: string, repo: Repo, branch: string, fetchFn: typeof fetch): Promise<BranchHead> {
  const ref = await call<{ object: { sha: string } }>(token, fetchFn, "GET", `${base(repo)}/git/ref/heads/${branch}`);
  const commit = await call<{ tree: { sha: string } }>(token, fetchFn, "GET", `${base(repo)}/git/commits/${ref.object.sha}`);
  return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
}

/** Path -> { mode, sha } for every blob in the tree. */
export async function getTreeIndex(
  token: string,
  repo: Repo,
  treeSha: string,
  fetchFn: typeof fetch,
): Promise<Map<string, { mode: string; sha: string }>> {
  const tree = await call<{ tree: { path: string; mode: string; type: string; sha: string }[]; truncated: boolean }>(
    token,
    fetchFn,
    "GET",
    `${base(repo)}/git/trees/${treeSha}?recursive=1`,
  );
  if (tree.truncated) throw new Error("Repository tree is too large to read in one request");
  return new Map(tree.tree.filter((e) => e.type === "blob").map((e) => [e.path, { mode: e.mode, sha: e.sha }]));
}

/** UTF-8 content of a blob. Binary content is rejected earlier by patch validation. */
export async function getBlobText(token: string, repo: Repo, sha: string, fetchFn: typeof fetch): Promise<string> {
  const blob = await call<{ content: string; encoding: string }>(token, fetchFn, "GET", `${base(repo)}/git/blobs/${sha}`);
  if (blob.encoding !== "base64") return blob.content;
  const bytes = Uint8Array.from(atob(blob.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export interface TreeChange {
  path: string;
  /** New file content, or null to delete the path. */
  content: string | null;
  mode: string;
}

export async function commitChanges(
  token: string,
  repo: Repo,
  head: BranchHead,
  changes: TreeChange[],
  message: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const tree = await call<{ sha: string }>(token, fetchFn, "POST", `${base(repo)}/git/trees`, {
    base_tree: head.treeSha,
    tree: changes.map((c) =>
      c.content === null
        ? { path: c.path, mode: c.mode, type: "blob", sha: null }
        : { path: c.path, mode: c.mode, type: "blob", content: c.content },
    ),
  });
  const commit = await call<{ sha: string }>(token, fetchFn, "POST", `${base(repo)}/git/commits`, {
    message,
    tree: tree.sha,
    parents: [head.commitSha],
  });
  return commit.sha;
}

/** Points `branch` at `sha`, creating it or force-updating an earlier attempt. */
export async function setBranch(token: string, repo: Repo, branch: string, sha: string, fetchFn: typeof fetch): Promise<void> {
  const res = await fetchFn(`${GITHUB_API}${base(repo)}/git/refs/heads/${branch}`, {
    method: "PATCH",
    headers: { ...githubHeaders(`Bearer ${token}`), "Content-Type": "application/json" },
    body: JSON.stringify({ sha, force: true }),
  });
  if (res.ok) return;
  if (res.status !== 404 && res.status !== 422) {
    throw new Error(`GitHub update ref failed: ${res.status} ${await res.text()}`);
  }
  await call(token, fetchFn, "POST", `${base(repo)}/git/refs`, { ref: `refs/heads/${branch}`, sha });
}

export async function openDraftPullRequest(
  token: string,
  repo: Repo,
  pr: { title: string; body: string; head: string; base: string },
  fetchFn: typeof fetch,
): Promise<{ number: number; url: string }> {
  const created = await call<{ number: number; html_url: string }>(token, fetchFn, "POST", `${base(repo)}/pulls`, {
    ...pr,
    draft: true,
  });
  return { number: created.number, url: created.html_url };
}

export async function getIssue(
  token: string,
  repo: Repo,
  issueNumber: number,
  fetchFn: typeof fetch,
): Promise<{ title: string; body: string }> {
  const issue = await call<{ title: string; body: string | null }>(token, fetchFn, "GET", `${base(repo)}/issues/${issueNumber}`);
  return { title: issue.title, body: issue.body ?? "" };
}
