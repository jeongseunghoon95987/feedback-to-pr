/**
 * Usage limits. Each limit is optional: null means unlimited, which keeps a
 * self-hosted install working as before. The hosted beta sets all three.
 */
export interface UsageLimits {
  /** Reports one Discord user may send per rolling hour, per tenant. */
  reportsPerUserHour: number | null;
  /** Reports a tenant may send per calendar month (UTC). */
  reportsPerMonth: number | null;
  /** Coding agent runs a tenant may start per calendar month (UTC). */
  agentRunsPerMonth: number | null;
}

export type ReportDecision = "ok" | "user_rate_limited" | "monthly_limit";

/** Checks a limit and, when the work is allowed, counts it. */
export interface UsageGate {
  allowReport(tenantId: string, reporterId: string): Promise<ReportDecision>;
  allowAgentRun(tenantId: string): Promise<boolean>;
}

export interface LimitConfig {
  LIMIT_REPORTS_PER_USER_HOUR?: string;
  LIMIT_REPORTS_PER_MONTH?: string;
  LIMIT_AGENT_RUNS_PER_MONTH?: string;
}

export function parseLimits(config: LimitConfig): UsageLimits {
  return {
    reportsPerUserHour: parseLimit(config.LIMIT_REPORTS_PER_USER_HOUR),
    reportsPerMonth: parseLimit(config.LIMIT_REPORTS_PER_MONTH),
    agentRunsPerMonth: parseLimit(config.LIMIT_AGENT_RUNS_PER_MONTH),
  };
}

/** Empty or missing means unlimited. A non-negative integer is a limit; 0 blocks everything. */
function parseLimit(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) throw new Error(`Invalid usage limit "${text}": use a whole number, or leave it empty for no limit`);
  return Number.parseInt(text, 10);
}

/** The usage period a moment falls in: 'YYYY-MM' in UTC. */
export function usagePeriod(now: Date): string {
  return now.toISOString().slice(0, 7);
}
