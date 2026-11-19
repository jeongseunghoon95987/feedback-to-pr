import type { AgentRequest } from "../github/webhook";

export type AgentRunStatus = "queued" | "running" | "succeeded" | "failed" | "rejected";

export interface AgentRun extends AgentRequest {
  id: number;
  tenantId: string;
  deliveryId: string;
  status: AgentRunStatus;
  sessionId: string | null;
  error: string | null;
}

/** Queue message that starts processing of an agent run. */
export interface AgentJob {
  kind: "agent";
  runId: number;
}

export interface AgentRunStore {
  /** The tenant that connected this repository, or null if it is not connected. */
  findTenantByRepo(owner: string, repo: string): Promise<string | null>;
  /** Inserts a run; returns null when this delivery was already recorded. */
  insertRun(tenantId: string, deliveryId: string, request: AgentRequest): Promise<number | null>;
  getRun(id: number): Promise<AgentRun | null>;
  /** True if another run for the same issue is queued or running. */
  hasActiveRun(run: AgentRun): Promise<boolean>;
  updateRun(id: number, fields: { status: AgentRunStatus; sessionId?: string | null; error?: string | null }): Promise<void>;
}

interface RunRow {
  id: number;
  tenant_id: string;
  delivery_id: string;
  owner: string;
  repo: string;
  issue_number: number;
  requested_by: string;
  status: AgentRunStatus;
  session_id: string | null;
  error: string | null;
}

/** installation_id is not stored per run; it comes from github_repos via the tenant. */
export class D1AgentRunStore implements AgentRunStore {
  constructor(private readonly db: D1Database) {}

  async findTenantByRepo(owner: string, repo: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT tenant_id FROM github_repos WHERE lower(owner) = lower(?) AND lower(repo) = lower(?)")
      .bind(owner, repo)
      .first<{ tenant_id: string }>();
    return row?.tenant_id ?? null;
  }

  async insertRun(tenantId: string, deliveryId: string, request: AgentRequest): Promise<number | null> {
    const row = await this.db
      .prepare(
        `INSERT INTO agent_runs (tenant_id, delivery_id, owner, repo, issue_number, requested_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(delivery_id) DO NOTHING
         RETURNING id`,
      )
      .bind(tenantId, deliveryId, request.owner, request.repo, request.issueNumber, request.requestedBy)
      .first<{ id: number }>();
    return row?.id ?? null;
  }

  async getRun(id: number): Promise<AgentRun | null> {
    const row = await this.db
      .prepare(
        `SELECT r.*, g.installation_id FROM agent_runs r
         JOIN github_repos g ON g.tenant_id = r.tenant_id
         WHERE r.id = ?`,
      )
      .bind(id)
      .first<RunRow & { installation_id: number }>();
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      deliveryId: row.delivery_id,
      owner: row.owner,
      repo: row.repo,
      issueNumber: row.issue_number,
      requestedBy: row.requested_by,
      installationId: row.installation_id,
      status: row.status,
      sessionId: row.session_id,
      error: row.error,
    };
  }

  async hasActiveRun(run: AgentRun): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 FROM agent_runs
         WHERE tenant_id = ? AND owner = ? AND repo = ? AND issue_number = ?
           AND id != ? AND status IN ('queued', 'running')
         LIMIT 1`,
      )
      .bind(run.tenantId, run.owner, run.repo, run.issueNumber, run.id)
      .first();
    return row !== null;
  }

  async updateRun(
    id: number,
    fields: { status: AgentRunStatus; sessionId?: string | null; error?: string | null },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE agent_runs
         SET status = ?, session_id = COALESCE(?, session_id), error = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(fields.status, fields.sessionId ?? null, fields.error ?? null, id)
      .run();
  }
}
