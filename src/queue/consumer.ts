import { t } from "../core/i18n";
import type { ReportJob } from "../core/types";
import { DISCORD_API } from "../connectors/discord/api";
import type { Store } from "../db/store";
import { createIssue, type CreatedIssue } from "../github/api";
import { getInstallationToken, type AppCredentials } from "../github/auth";
import { buildIssue } from "../github/issue-format";

export interface ConsumerDeps {
  store: Store;
  fetch: typeof fetch;
  /** GitHub App credentials; when absent, reports are acknowledged but no issue is filed. */
  github: AppCredentials | null;
}

/**
 * Processes one queued report:
 *   1. file a GitHub issue (if the tenant has a connected repository)
 *   2. replace Discord's "thinking..." placeholder with a receipt
 * Each step is recorded before the next one, so a retried job resumes where
 * it stopped instead of filing a duplicate issue.
 */
export async function processReport(job: ReportJob, deps: ConsumerDeps): Promise<void> {
  const report = await deps.store.getReport(job.reportId);
  if (!report) throw new Error(`Report ${job.reportId} not found`);
  if (report.status === "received") return; // already finished by an earlier delivery

  let issue: CreatedIssue | null =
    report.issueNumber !== null && report.issueUrl ? { number: report.issueNumber, url: report.issueUrl } : null;

  if (!issue) {
    const repo = await deps.store.findRepo(report.tenantId);
    if (repo && deps.github) {
      const token = await getInstallationToken(deps.github, repo.installationId, deps.fetch);
      issue = await createIssue(token, repo, buildIssue(report), deps.fetch);
      await deps.store.markIssueCreated(report.id, issue.number, issue.url);
    } else {
      console.warn(`Report ${report.id}: no GitHub repository connected for tenant ${report.tenantId}; skipping issue`);
    }
  }

  const msg = t(job.locale);
  const content = issue ? msg.receivedWithIssue(report.title, report.id, issue.url) : msg.received(report.title, report.id);
  const message = await editOriginalResponse(job, content, deps.fetch);
  await deps.store.markReceived(report.id, message.id);
}

/** Replaces the "thinking..." placeholder of the deferred interaction response. */
async function editOriginalResponse(job: ReportJob, content: string, fetchFn: typeof fetch): Promise<{ id: string }> {
  const url = `${DISCORD_API}/webhooks/${job.interaction.applicationId}/${job.interaction.token}/messages/@original`;
  const res = await fetchFn(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    // Report text comes from users; never let it ping anyone.
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) {
    throw new Error(`Discord edit original response failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { id: string };
}

/** Must match max_retries for the consumer in wrangler.toml. */
export const MAX_RETRIES = 3;

export async function consumeBatch(batch: MessageBatch<ReportJob>, deps: ConsumerDeps): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processReport(message.body, deps);
      message.ack();
    } catch (error) {
      console.error("Failed to process report", message.body.reportId, `attempt ${message.attempts}`, error);
      if (message.attempts <= MAX_RETRIES) {
        message.retry();
        continue;
      }
      // Last attempt: tell the reporter instead of leaving "thinking..." until the token expires.
      try {
        await editOriginalResponse(message.body, t(message.body.locale).processingFailed, deps.fetch);
      } catch (notifyError) {
        console.error("Failed to send failure notice", message.body.reportId, notifyError);
      }
      message.ack();
    }
  }
}
