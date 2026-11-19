import type { FeedbackReport, ReportJob } from "../src/core/types";
import type { AgentRun, AgentRunStatus, AgentRunStore } from "../src/agent/runs";
import type { GuildConnection, Store, StoredReport } from "../src/db/store";
import type { RepoRef } from "../src/github/api";
import type { TriageResult } from "../src/triage/triage";

export class MemoryStore implements Store {
  guilds = new Map<string, GuildConnection>();
  repos = new Map<string, RepoRef>();
  reports: StoredReport[] = [];

  async saveTriage(id: number, triage: TriageResult): Promise<void> {
    const report = this.reports.find((r) => r.id === id);
    if (report) report.triage = triage;
  }

  async markRejected(id: number, discordMessageId: string): Promise<void> {
    const report = this.reports.find((r) => r.id === id);
    if (report) Object.assign(report, { status: "rejected", discordMessageId });
  }

  async findRepo(tenantId: string): Promise<RepoRef | null> {
    return this.repos.get(tenantId) ?? null;
  }

  async markIssueCreated(id: number, issueNumber: number, issueUrl: string): Promise<void> {
    const report = this.reports.find((r) => r.id === id);
    if (report) Object.assign(report, { status: "issue_created", issueNumber, issueUrl });
  }

  async findGuild(guildId: string): Promise<GuildConnection | null> {
    return this.guilds.get(guildId) ?? null;
  }

  async insertReport(report: FeedbackReport): Promise<number> {
    const id = this.reports.length + 1;
    this.reports.push({
      ...report,
      id,
      status: "queued",
      discordMessageId: null,
      issueNumber: null,
      issueUrl: null,
      triage: null,
    });
    return id;
  }

  async getReport(id: number): Promise<StoredReport | null> {
    return this.reports.find((r) => r.id === id) ?? null;
  }

  async markReceived(id: number, discordMessageId: string): Promise<void> {
    const report = this.reports.find((r) => r.id === id);
    if (report) {
      report.status = "received";
      report.discordMessageId = discordMessageId;
    }
  }
}

export function setup() {
  const store = new MemoryStore();
  store.guilds.set("guild-1", { tenantId: "default", allowedChannelIds: null });
  const jobs: ReportJob[] = [];
  return { store, jobs, deps: { store, enqueue: async (job: ReportJob) => void jobs.push(job) } };
}

export const baseInteraction = {
  id: "interaction-1",
  application_id: "app-1",
  token: "token-1",
  guild_id: "guild-1",
  channel_id: "channel-1",
  locale: "en-US",
  member: { user: { id: "user-1", username: "reporter" } },
};

export class MemoryRuns implements AgentRunStore {
  runs: AgentRun[] = [];
  active = false;
  async findTenantByRepo() {
    return "default";
  }
  async insertRun() {
    return null;
  }
  async getRun(id: number) {
    return this.runs.find((r) => r.id === id) ?? null;
  }
  async hasActiveRun() {
    return this.active;
  }
  async updateRun(id: number, fields: { status: AgentRunStatus; sessionId?: string | null; error?: string | null }) {
    const run = this.runs.find((r) => r.id === id);
    if (run) Object.assign(run, { status: fields.status, sessionId: fields.sessionId ?? run.sessionId, error: fields.error ?? null });
  }
  async findRunBySession(sessionId: string) {
    return this.runs.find((r) => r.sessionId === sessionId) ?? null;
  }
  async claimRun(id: number, from: AgentRunStatus, to: AgentRunStatus) {
    const run = this.runs.find((r) => r.id === id);
    if (!run || run.status !== from) return false;
    run.status = to;
    return true;
  }
  prNumber: number | null = null;
  async setPullRequest(_id: number, prNumber: number) {
    this.prNumber = prNumber;
  }
}
