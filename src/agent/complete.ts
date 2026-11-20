import { addIssueComment, swapLabels, type RepoRef } from "../github/api";
import { getInstallationToken, type AppCredentials } from "../github/auth";
import { commitChanges, getBlobText, getBranchHead, getDefaultBranch, getTreeIndex, openDraftPullRequest, setBranch } from "../github/git";
import { AGENT_DONE_LABEL, AGENT_FAILED_LABEL, AGENT_WORKING_LABEL } from "../github/webhook";
import type { AgentSessions } from "./managed";
import { PatchRejected, buildTreeChanges, parseAgentPatch } from "./patch";
import type { AgentCompleteJob, AgentRunStore } from "./runs";

export interface CompleteDeps {
  runs: AgentRunStore;
  sessions: AgentSessions;
  github: AppCredentials;
  fetch: typeof fetch;
}

/**
 * Runs when a session stops. Reads what the agent produced, checks the patch,
 * and either opens a draft PR with the GitHub App or explains on the issue
 * why there is none. The session is deleted afterwards.
 */
export async function completeAgentRun(job: AgentCompleteJob, deps: CompleteDeps): Promise<void> {
  const run = await deps.runs.findRunBySession(job.sessionId);
  if (!run) return; // not one of ours, or already cleaned up

  const state = await deps.sessions.getState(job.sessionId);
  if (state.status === "running" || state.status === "rescheduling") return; // a later webhook will follow
  // Webhooks can arrive more than once; only one delivery finishes the run.
  if (!(await deps.runs.claimRun(run.id, "running", "finishing"))) return;

  const repo: RepoRef = { installationId: run.installationId, owner: run.owner, repo: run.repo };
  const token = await getInstallationToken(deps.github, repo.installationId, deps.fetch);
  const comment = (body: string) => addIssueComment(token, repo, run.issueNumber, body, deps.fetch);
  const finish = async (ok: boolean, error: string | null) => {
    await swapLabels(token, repo, run.issueNumber, AGENT_WORKING_LABEL, [ok ? AGENT_DONE_LABEL : AGENT_FAILED_LABEL], deps.fetch);
    await deps.runs.updateRun(run.id, { status: ok ? "succeeded" : "failed", error });
    await deps.sessions.delete(job.sessionId).catch((e) => console.error(`Could not delete session ${job.sessionId}`, e));
  };

  try {
    if (state.status !== "idle" || state.stopReason !== "end_turn") {
      const reason =
        state.stopReason === "budget_reached"
          ? "it reached its spending limit"
          : `it stopped unexpectedly (${state.status}${state.stopReason ? `, ${state.stopReason}` : ""})`;
      await comment(`The coding agent did not finish because ${reason}. No pull request was opened.`);
      await finish(false, `session ${state.status} ${state.stopReason ?? ""}`.trim());
      return;
    }

    const outputs = await deps.sessions.getOutputs(job.sessionId);
    const summary = quote(outputs.get("summary.md") ?? "The agent did not leave a summary.");
    const patchText = outputs.get("fix.patch");

    if (!patchText?.trim()) {
      await comment(`The coding agent looked into this but did not propose a change.\n\n**Agent's notes** (generated, may be wrong):\n\n${summary}`);
      await finish(false, "no patch");
      return;
    }

    const baseBranch = await getDefaultBranch(token, repo, deps.fetch);
    const head = await getBranchHead(token, repo, baseBranch, deps.fetch);
    const index = await getTreeIndex(token, repo, head.treeSha, deps.fetch);
    const changes = await buildTreeChanges(parseAgentPatch(patchText), async (path) => {
      const entry = index.get(path);
      return entry ? { text: await getBlobText(token, repo, entry.sha, deps.fetch), mode: entry.mode } : null;
    });

    const branch = `feedback-to-pr/issue-${run.issueNumber}`;
    const commitSha = await commitChanges(token, repo, head, changes, `Resolve #${run.issueNumber} (feedback-to-pr agent)`, deps.fetch);
    await setBranch(token, repo, branch, commitSha, deps.fetch);
    const pr = await openDraftPullRequest(
      token,
      repo,
      {
        title: `Resolve #${run.issueNumber}`,
        head: branch,
        base: baseBranch,
        body: [
          `Fixes #${run.issueNumber}`,
          "",
          "Draft opened by the feedback-to-pr coding agent after a maintainer approved the issue. Review it like any outside contribution.",
          "",
          "**Agent's notes** (generated from an untrusted user report, may be wrong):",
          "",
          summary,
        ].join("\n"),
      },
      deps.fetch,
    );
    await deps.runs.setPullRequest(run.id, pr.number);
    await comment(`The coding agent opened a draft pull request: ${pr.url}`);
    await finish(true, null);
  } catch (error) {
    const reason = error instanceof PatchRejected ? `its change was rejected: ${error.message}` : "of an internal error";
    await comment(`The coding agent's result could not be used because ${reason}. No pull request was opened.`).catch(() => {});
    await finish(false, String(error).slice(0, 500)).catch(() => {});
  }
}

/** Agent text is shown as a quote with mentions and references neutralized. */
function quote(text: string): string {
  return text
    .trim()
    .slice(0, 3000)
    .replace(/[@#]/g, (c) => `${c}​`)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
