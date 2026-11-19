import { t } from "../core/i18n";
import type { ReportJob } from "../core/types";
import { DISCORD_API } from "../connectors/discord/api";
import type { StoredReport, Store } from "../db/store";
import { addIssueComment, createIssue, issueUrl, listOpenIssues, type RepoRef } from "../github/api";
import { getInstallationToken, type AppCredentials } from "../github/auth";
import { buildDuplicateComment, buildIssue } from "../github/issue-format";
import type { Triager, TriageResult } from "../triage/triage";

export interface ConsumerDeps {
  store: Store;
  fetch: typeof fetch;
  /** GitHub App credentials; when absent, reports are acknowledged but no issue is filed. */
  github: AppCredentials | null;
  /** AI triage; when absent, issues are filed without a summary or category. */
  triager: Triager | null;
}

type Outcome =
  | { kind: "filed"; url: string }
  | { kind: "duplicate"; url: string }
  | { kind: "rejected" }
  | { kind: "acknowledged" };

/**
 * Processes one queued report:
 *   1. triage it (category, summary, duplicate check), if a triager is configured
 *   2. file a new issue, comment on the duplicated issue, or reject spam
 *   3. replace Discord's "thinking..." placeholder with the outcome
 * Each step is recorded before the next one, so a retried job resumes where
 * it stopped instead of calling the model again or filing a duplicate issue.
 */
export async function processReport(job: ReportJob, deps: ConsumerDeps): Promise<void> {
  const report = await deps.store.getReport(job.reportId);
  if (!report) throw new Error(`Report ${job.reportId} not found`);
  if (report.status === "received" || report.status === "rejected") return; // finished by an earlier delivery

  const outcome = await fileReport(report, deps);

  const msg = t(job.locale);
  const content =
    outcome.kind === "filed"
      ? msg.receivedWithIssue(report.title, report.id, outcome.url)
      : outcome.kind === "duplicate"
        ? msg.receivedDuplicate(report.title, report.id, outcome.url)
        : outcome.kind === "rejected"
          ? msg.notFiled(report.title, report.id)
          : msg.received(report.title, report.id);
  const message = await editOriginalResponse(job, content, deps.fetch);

  if (outcome.kind === "rejected") await deps.store.markRejected(report.id, message.id);
  else await deps.store.markReceived(report.id, message.id);
}

async function fileReport(report: StoredReport, deps: ConsumerDeps): Promise<Outcome> {
  // Resume: the GitHub side was already done by an earlier attempt.
  if (report.issueNumber !== null && report.issueUrl) {
    return { kind: report.triage?.duplicateOf === report.issueNumber ? "duplicate" : "filed", url: report.issueUrl };
  }

  const repo = await deps.store.findRepo(report.tenantId);
  if (!repo || !deps.github) {
    console.warn(`Report ${report.id}: no GitHub repository connected for tenant ${report.tenantId}; skipping issue`);
    return { kind: "acknowledged" };
  }
  const token = await getInstallationToken(deps.github, repo.installationId, deps.fetch);

  const triage = report.triage ?? (await runTriage(report, token, repo, deps));

  // Low-confidence spam is still filed, so a human makes the call.
  if (triage?.category === "spam" && triage.confidence !== "low") {
    return { kind: "rejected" };
  }

  if (triage?.duplicateOf) {
    await addIssueComment(token, repo, triage.duplicateOf, buildDuplicateComment(report, triage), deps.fetch);
    const url = issueUrl(repo, triage.duplicateOf);
    await deps.store.markIssueCreated(report.id, triage.duplicateOf, url);
    return { kind: "duplicate", url };
  }

  const issue = await createIssue(token, repo, buildIssue(report, triage), deps.fetch);
  await deps.store.markIssueCreated(report.id, issue.number, issue.url);
  return { kind: "filed", url: issue.url };
}

/** Triage is best effort: any failure files the report without it rather than blocking. */
async function runTriage(
  report: StoredReport,
  token: string,
  repo: RepoRef,
  deps: ConsumerDeps,
): Promise<TriageResult | null> {
  if (!deps.triager) return null;
  try {
    const candidates = await listOpenIssues(token, repo, deps.fetch);
    const triage = await deps.triager.triage(report, candidates);
    if (triage) await deps.store.saveTriage(report.id, triage);
    return triage;
  } catch (error) {
    console.error(`Triage failed for report ${report.id}; filing without triage`, error);
    return null;
  }
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
