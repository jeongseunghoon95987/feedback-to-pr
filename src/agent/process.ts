import { addIssueComment, getUserPermission, swapLabels, type RepoRef } from "../github/api";
import { getInstallationToken, type AppCredentials } from "../github/auth";
import { AGENT_FAILED_LABEL, AGENT_GO_LABEL, AGENT_WORKING_LABEL } from "../github/webhook";
import type { UsageGate } from "../core/usage";
import type { AgentJob, AgentRun, AgentRunStore } from "./runs";

/** Must match max_retries for the consumer in wrangler.toml. */
const MAX_RETRIES = 3;

export async function consumeAgentMessages(messages: readonly Message<AgentJob>[], deps: AgentDeps): Promise<void> {
  for (const message of messages) {
    try {
      await processAgentRun(message.body, deps);
      message.ack();
    } catch (error) {
      console.error("Failed to process agent run", message.body.runId, `attempt ${message.attempts}`, error);
      if (message.attempts <= MAX_RETRIES) {
        message.retry();
        continue;
      }
      await deps.runs.updateRun(message.body.runId, { status: "failed", error: String(error).slice(0, 500) }).catch(() => {});
      message.ack();
    }
  }
}

/** Starts the coding agent for a run. Implementations: Managed Agents (next step). */
export interface AgentRunner {
  start(run: AgentRun): Promise<{ sessionId: string }>;
}

export interface AgentDeps {
  runs: AgentRunStore;
  fetch: typeof fetch;
  github: AppCredentials | null;
  runner: AgentRunner | null;
  /** Usage limits; without it agent runs are not limited. */
  usage?: UsageGate;
}

const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

/**
 * Handles an `agent:go` request:
 *   1. re-check that the person who added the label has write access
 *   2. skip if a run for the same issue is already in progress
 *   3. swap agent:go for agent:working and start the agent
 * Every outcome is recorded on the run and explained on the issue.
 */
export async function processAgentRun(job: AgentJob, deps: AgentDeps): Promise<void> {
  const run = await deps.runs.getRun(job.runId);
  if (!run) throw new Error(`Agent run ${job.runId} not found`);
  if (run.status !== "queued") return; // handled by an earlier delivery
  if (!deps.github) throw new Error("GitHub App credentials are not configured");

  const repo: RepoRef = { installationId: run.installationId, owner: run.owner, repo: run.repo };
  const token = await getInstallationToken(deps.github, repo.installationId, deps.fetch);
  const comment = (body: string) => addIssueComment(token, repo, run.issueNumber, body, deps.fetch);

  // GitHub lets triage-level users add labels; only write access may start the agent.
  const permission = await getUserPermission(token, repo, run.requestedBy, deps.fetch);
  if (!WRITE_PERMISSIONS.has(permission)) {
    await swapLabels(token, repo, run.issueNumber, AGENT_GO_LABEL, [], deps.fetch);
    await comment(
      `The \`${AGENT_GO_LABEL}\` label was added by \`${run.requestedBy}\`, who does not have write access ` +
        `(permission: \`${permission}\`). The coding agent was not started.`,
    );
    await deps.runs.updateRun(run.id, { status: "rejected", error: `permission: ${permission}` });
    return;
  }

  if (await deps.runs.hasActiveRun(run)) {
    await swapLabels(token, repo, run.issueNumber, AGENT_GO_LABEL, [], deps.fetch);
    await comment("The coding agent is already working on this issue. Wait for it to finish before starting another run.");
    await deps.runs.updateRun(run.id, { status: "rejected", error: "another run is active" });
    return;
  }

  if (!deps.runner) {
    await swapLabels(token, repo, run.issueNumber, AGENT_GO_LABEL, [AGENT_FAILED_LABEL], deps.fetch);
    await comment("The server-side coding agent is not configured for this installation, so no run was started.");
    await deps.runs.updateRun(run.id, { status: "failed", error: "runner not configured" });
    return;
  }

  // Counted last, so a run rejected above does not use up the monthly allowance.
  if (deps.usage && !(await deps.usage.allowAgentRun(run.tenantId))) {
    await swapLabels(token, repo, run.issueNumber, AGENT_GO_LABEL, [AGENT_FAILED_LABEL], deps.fetch);
    await comment(
      "This repository has reached its coding agent limit for this month, so no run was started. " +
        "The label can be added again next month.",
    );
    await deps.runs.updateRun(run.id, { status: "rejected", error: "monthly agent run limit" });
    return;
  }

  await swapLabels(token, repo, run.issueNumber, AGENT_GO_LABEL, [AGENT_WORKING_LABEL], deps.fetch);
  try {
    const { sessionId } = await deps.runner.start(run);
    await deps.runs.updateRun(run.id, { status: "running", sessionId });
  } catch (error) {
    await swapLabels(token, repo, run.issueNumber, AGENT_WORKING_LABEL, [AGENT_FAILED_LABEL], deps.fetch);
    await comment("The coding agent could not be started. A maintainer can add the label again to retry.");
    await deps.runs.updateRun(run.id, { status: "failed", error: String(error).slice(0, 500) });
  }
}
