import type { FeedbackReport, ReportFields } from "../core/types";
import type { RepoRef } from "../github/api";
import type { TriageResult } from "../triage/triage";

/** A Discord server connected to a tenant. */
export interface GuildConnection {
  tenantId: string;
  /** null means every channel in the server is allowed. */
  allowedChannelIds: string[] | null;
}

/**
 * queued -> issue_created -> received, or queued -> rejected (triaged as spam).
 * "received" and "rejected" are final: the reporter has been told the outcome.
 */
export type ReportStatus = "queued" | "issue_created" | "received" | "rejected";

export interface StoredReport extends FeedbackReport {
  id: number;
  status: ReportStatus;
  discordMessageId: string | null;
  /** The issue filed for this report, or the existing issue it duplicates. */
  issueNumber: number | null;
  issueUrl: string | null;
  triage: TriageResult | null;
}

/** Persistence used by the Discord intake and the queue consumer. */
export interface Store {
  findGuild(guildId: string): Promise<GuildConnection | null>;
  insertReport(report: FeedbackReport): Promise<number>;
  getReport(id: number): Promise<StoredReport | null>;
  /** The repository a tenant files issues in, or null if not connected yet. */
  findRepo(tenantId: string): Promise<RepoRef | null>;
  saveTriage(id: number, triage: TriageResult): Promise<void>;
  markIssueCreated(id: number, issueNumber: number, issueUrl: string): Promise<void>;
  markReceived(id: number, discordMessageId: string): Promise<void>;
  markRejected(id: number, discordMessageId: string): Promise<void>;
}

interface GuildRow {
  tenant_id: string;
  allowed_channel_ids: string | null;
}

interface ReportRow {
  id: number;
  tenant_id: string;
  source: "discord";
  kind: FeedbackReport["kind"];
  guild_id: string;
  channel_id: string;
  source_message_id: string | null;
  reporter_id: string;
  reported_author_id: string | null;
  title: string;
  fields: string;
  redactions: number;
  status: ReportStatus;
  discord_message_id: string | null;
  issue_number: number | null;
  issue_url: string | null;
  triage: string | null;
}

interface RepoRow {
  installation_id: number;
  owner: string;
  repo: string;
}

export class D1Store implements Store {
  constructor(private readonly db: D1Database) {}

  async findGuild(guildId: string): Promise<GuildConnection | null> {
    const row = await this.db
      .prepare("SELECT tenant_id, allowed_channel_ids FROM discord_guilds WHERE guild_id = ?")
      .bind(guildId)
      .first<GuildRow>();
    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      allowedChannelIds: row.allowed_channel_ids ? (JSON.parse(row.allowed_channel_ids) as string[]) : null,
    };
  }

  async insertReport(report: FeedbackReport): Promise<number> {
    const row = await this.db
      .prepare(
        `INSERT INTO reports
           (tenant_id, source, kind, guild_id, channel_id, source_message_id,
            reporter_id, reported_author_id, title, fields, redactions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .bind(
        report.tenantId,
        report.source,
        report.kind,
        report.guildId,
        report.channelId,
        report.sourceMessageId,
        report.reporterId,
        report.reportedAuthorId,
        report.title,
        JSON.stringify(report.fields),
        report.redactions,
      )
      .first<{ id: number }>();
    if (!row) throw new Error("Insert into reports returned no id");
    return row.id;
  }

  async getReport(id: number): Promise<StoredReport | null> {
    const row = await this.db.prepare("SELECT * FROM reports WHERE id = ?").bind(id).first<ReportRow>();
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      source: row.source,
      kind: row.kind,
      guildId: row.guild_id,
      channelId: row.channel_id,
      sourceMessageId: row.source_message_id,
      reporterId: row.reporter_id,
      reportedAuthorId: row.reported_author_id,
      title: row.title,
      fields: JSON.parse(row.fields) as ReportFields,
      redactions: row.redactions,
      status: row.status,
      discordMessageId: row.discord_message_id,
      issueNumber: row.issue_number,
      issueUrl: row.issue_url,
      triage: row.triage ? (JSON.parse(row.triage) as TriageResult) : null,
    };
  }

  async saveTriage(id: number, triage: TriageResult): Promise<void> {
    await this.db.prepare("UPDATE reports SET triage = ? WHERE id = ?").bind(JSON.stringify(triage), id).run();
  }

  async markRejected(id: number, discordMessageId: string): Promise<void> {
    await this.db
      .prepare("UPDATE reports SET status = 'rejected', discord_message_id = ? WHERE id = ?")
      .bind(discordMessageId, id)
      .run();
  }

  async findRepo(tenantId: string): Promise<RepoRef | null> {
    const row = await this.db
      .prepare("SELECT installation_id, owner, repo FROM github_repos WHERE tenant_id = ?")
      .bind(tenantId)
      .first<RepoRow>();
    return row ? { installationId: row.installation_id, owner: row.owner, repo: row.repo } : null;
  }

  async markIssueCreated(id: number, issueNumber: number, issueUrl: string): Promise<void> {
    await this.db
      .prepare("UPDATE reports SET status = 'issue_created', issue_number = ?, issue_url = ? WHERE id = ?")
      .bind(issueNumber, issueUrl, id)
      .run();
  }

  async markReceived(id: number, discordMessageId: string): Promise<void> {
    await this.db
      .prepare("UPDATE reports SET status = 'received', discord_message_id = ? WHERE id = ?")
      .bind(discordMessageId, id)
      .run();
  }
}
