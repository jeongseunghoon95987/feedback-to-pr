import { describe, expect, it } from "vitest";
import { parseLimits, usagePeriod } from "../src/core/usage";

describe("parseLimits", () => {
  it("treats missing and empty values as unlimited", () => {
    expect(parseLimits({})).toEqual({ reportsPerUserHour: null, reportsPerMonth: null, agentRunsPerMonth: null });
    expect(parseLimits({ LIMIT_REPORTS_PER_MONTH: "  " }).reportsPerMonth).toBeNull();
  });

  it("reads whole numbers, including 0", () => {
    expect(
      parseLimits({ LIMIT_REPORTS_PER_USER_HOUR: "5", LIMIT_REPORTS_PER_MONTH: "200", LIMIT_AGENT_RUNS_PER_MONTH: "0" }),
    ).toEqual({ reportsPerUserHour: 5, reportsPerMonth: 200, agentRunsPerMonth: 0 });
  });

  it.each(["-1", "1.5", "ten"])("rejects %s instead of silently ignoring it", (value) => {
    expect(() => parseLimits({ LIMIT_AGENT_RUNS_PER_MONTH: value })).toThrow("Invalid usage limit");
  });
});

describe("usagePeriod", () => {
  it("uses the UTC month", () => {
    expect(usagePeriod(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11");
    expect(usagePeriod(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
  });
});
