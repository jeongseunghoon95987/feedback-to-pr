import { t } from "../core/i18n";
import type { ReportJob } from "../core/types";
import { DISCORD_API } from "../connectors/discord/api";
import type { Store } from "../db/store";

export interface ConsumerDeps {
  store: Store;
  fetch: typeof fetch;
}

/**
 * Processes one queued report. For now it confirms receipt in Discord by
 * filling in the deferred interaction response. Triage, issue creation and the
 * report thread are added in later steps.
 */
export async function processReport(job: ReportJob, deps: ConsumerDeps): Promise<void> {
  const report = await deps.store.getReport(job.reportId);
  if (!report) throw new Error(`Report ${job.reportId} not found`);
  if (report.status !== "queued") return; // already handled by an earlier delivery

  const url = `${DISCORD_API}/webhooks/${job.interaction.applicationId}/${job.interaction.token}/messages/@original`;
  const res = await deps.fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: t(job.locale).received(report.title, report.id),
      // Report text comes from users; never let it ping anyone.
      allowed_mentions: { parse: [] },
    }),
  });
  if (!res.ok) {
    throw new Error(`Discord edit original response failed: ${res.status} ${await res.text()}`);
  }
  const message = (await res.json()) as { id: string };
  await deps.store.markReceived(report.id, message.id);
}

export async function consumeBatch(batch: MessageBatch<ReportJob>, deps: ConsumerDeps): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processReport(message.body, deps);
      message.ack();
    } catch (error) {
      console.error("Failed to process report", message.body.reportId, error);
      message.retry();
    }
  }
}
