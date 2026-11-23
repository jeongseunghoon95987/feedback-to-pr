-- Monthly usage per tenant, used to enforce limits before work that costs money
-- (AI triage of a report, a coding agent run). Counted when the work is accepted.
CREATE TABLE tenant_usage (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 'YYYY-MM' in UTC
  period TEXT NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0,
  agent_runs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period)
);
