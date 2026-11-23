import { usagePeriod, type ReportDecision, type UsageGate, type UsageLimits } from "../core/usage";

type Counter = "reports" | "agent_runs";

export class D1UsageGate implements UsageGate {
  constructor(
    private readonly db: D1Database,
    private readonly limits: UsageLimits,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async allowReport(tenantId: string, reporterId: string): Promise<ReportDecision> {
    const perHour = this.limits.reportsPerUserHour;
    if (perHour !== null) {
      // Concurrent submissions can pass this check together; one extra report is acceptable.
      const since = new Date(this.now().getTime() - 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      const row = await this.db
        .prepare("SELECT COUNT(*) AS n FROM reports WHERE tenant_id = ? AND reporter_id = ? AND created_at >= ?")
        .bind(tenantId, reporterId, since)
        .first<{ n: number }>();
      if ((row?.n ?? 0) >= perHour) return "user_rate_limited";
    }
    return (await this.take(tenantId, "reports", this.limits.reportsPerMonth)) ? "ok" : "monthly_limit";
  }

  allowAgentRun(tenantId: string): Promise<boolean> {
    return this.take(tenantId, "agent_runs", this.limits.agentRunsPerMonth);
  }

  /**
   * Adds one to the tenant's counter for this month if it is below the limit.
   * Check and increment are one statement, so concurrent requests cannot both
   * take the last slot. The counter is kept even without a limit, for usage stats.
   */
  private async take(tenantId: string, counter: Counter, limit: number | null): Promise<boolean> {
    if (limit !== null && limit <= 0) return false;
    const period = usagePeriod(this.now());
    // `counter` is one of two fixed column names, never user input.
    const guard = limit === null ? "" : ` WHERE ${counter} < ?`;
    const statement = this.db.prepare(
      `INSERT INTO tenant_usage (tenant_id, period, ${counter}) VALUES (?, ?, 1)
       ON CONFLICT (tenant_id, period) DO UPDATE SET ${counter} = ${counter} + 1${guard}
       RETURNING ${counter} AS n`,
    );
    const row = await (limit === null ? statement.bind(tenantId, period) : statement.bind(tenantId, period, limit)).first<{ n: number }>();
    return row !== null;
  }
}
