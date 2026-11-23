import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { processAgentRun, type AgentRunner } from "../src/agent/process";
import type { UsageGate } from "../src/core/usage";
import { MemoryRuns } from "./helpers";
import { agentRequestFrom, verifyGitHubSignature } from "../src/github/webhook";
import { app, type Env } from "../src/index";

const secret = "webhook-secret";
const sign = (body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("verifyGitHubSignature", () => {
  const body = JSON.stringify({ zen: "hi" });

  it("accepts a correct signature", async () => {
    expect(await verifyGitHubSignature(secret, sign(body), body)).toBe(true);
  });

  it("rejects a wrong secret, a tampered body, or a missing header", async () => {
    expect(await verifyGitHubSignature("other", sign(body), body)).toBe(false);
    expect(await verifyGitHubSignature(secret, sign(body), body + " ")).toBe(false);
    expect(await verifyGitHubSignature(secret, null, body)).toBe(false);
    expect(await verifyGitHubSignature("", sign(body), body)).toBe(false);
  });
});

function labeled(overrides: Record<string, unknown> = {}) {
  return {
    action: "labeled",
    label: { name: "agent:go" },
    issue: { number: 7, labels: [{ name: "source:discord" }, { name: "agent:go" }] },
    repository: { name: "app", owner: { login: "acme" } },
    sender: { login: "maintainer", type: "User" },
    installation: { id: 99 },
    ...overrides,
  };
}

describe("agentRequestFrom", () => {
  it("accepts agent:go added by a person to a feedback-to-pr issue", () => {
    expect(agentRequestFrom("issues", labeled())).toEqual({
      owner: "acme",
      repo: "app",
      issueNumber: 7,
      requestedBy: "maintainer",
      installationId: 99,
    });
  });

  it("ignores other events, labels, non-feedback issues, PRs and bots", () => {
    expect(agentRequestFrom("pull_request", labeled())).toBeNull();
    expect(agentRequestFrom("issues", labeled({ action: "unlabeled" }))).toBeNull();
    expect(agentRequestFrom("issues", labeled({ label: { name: "bug" } }))).toBeNull();
    expect(agentRequestFrom("issues", labeled({ issue: { number: 7, labels: [{ name: "agent:go" }] } }))).toBeNull();
    expect(
      agentRequestFrom("issues", labeled({ issue: { number: 7, labels: [{ name: "source:discord" }], pull_request: {} } })),
    ).toBeNull();
    expect(agentRequestFrom("issues", labeled({ sender: { login: "x[bot]", type: "Bot" } }))).toBeNull();
  });
});

describe("POST /github/webhook", () => {
  const env = { GITHUB_WEBHOOK_SECRET: secret } as unknown as Env;

  it("rejects unsigned deliveries", async () => {
    const res = await app.request("/github/webhook", { method: "POST", body: "{}" }, env);
    expect(res.status).toBe(401);
  });

  it("answers ping", async () => {
    const body = JSON.stringify({ zen: "hi" });
    const res = await app.request(
      "/github/webhook",
      { method: "POST", body, headers: { "X-Hub-Signature-256": sign(body), "X-GitHub-Event": "ping" } },
      env,
    );
    expect(await res.text()).toBe("pong");
  });

  it("ignores unrelated events without touching storage", async () => {
    const body = JSON.stringify(labeled({ label: { name: "bug" } }));
    const res = await app.request(
      "/github/webhook",
      { method: "POST", body, headers: { "X-Hub-Signature-256": sign(body), "X-GitHub-Event": "issues" } },
      env,
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("ignored");
  });
});


describe("processAgentRun", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const github = { appId: "1", privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };

  async function run(options: { permission?: string; active?: boolean; runner?: AgentRunner | null; usage?: UsageGate }) {
    const runs = new MemoryRuns();
    runs.active = options.active ?? false;
    runs.runs.push({
      id: 1,
      tenantId: "default",
      deliveryId: "d1",
      owner: "acme",
      repo: "app",
      issueNumber: 7,
      requestedBy: "maintainer",
      installationId: 99,
      status: "queued",
      sessionId: null,
      error: null,
    });
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith("/access_tokens")) return Response.json({ token: "t" });
      if (url.endsWith("/permission")) return Response.json({ permission: options.permission ?? "write" });
      if (url.includes("/labels")) return Response.json([]);
      if (url.endsWith("/comments")) return Response.json({ id: 1 });
      return new Response("unexpected", { status: 404 });
    });
    await processAgentRun(
      { kind: "agent", runId: 1 },
      {
        runs,
        fetch: fetchMock as unknown as typeof fetch,
        github,
        runner: options.runner === undefined ? null : options.runner,
        usage: options.usage,
      },
    );
    const labelsAdded = calls.filter((c) => c.method === "POST" && c.url.endsWith("/labels")).flatMap((c) => (c.body as { labels: string[] }).labels);
    const labelsRemoved = calls.filter((c) => c.method === "DELETE").map((c) => decodeURIComponent(c.url.split("/labels/")[1]!));
    const comments = calls.filter((c) => c.url.endsWith("/comments")).map((c) => (c.body as { body: string }).body);
    return { run: runs.runs[0]!, labelsAdded, labelsRemoved, comments };
  }

  it("rejects a requester without write access and removes the label", async () => {
    const r = await run({ permission: "triage", runner: { start: vi.fn() } });
    expect(r.run.status).toBe("rejected");
    expect(r.labelsRemoved).toEqual(["agent:go"]);
    expect(r.labelsAdded).toEqual([]);
    expect(r.comments[0]).toContain("does not have write access");
    expect(r.comments[0]).not.toContain("@maintainer"); // no mention pings
  });

  it("does not start a second run for the same issue", async () => {
    const start = vi.fn();
    const r = await run({ active: true, runner: { start } });
    expect(start).not.toHaveBeenCalled();
    expect(r.run.status).toBe("rejected");
  });

  it("fails clearly when no runner is configured", async () => {
    const r = await run({ runner: null });
    expect(r.run.status).toBe("failed");
    expect(r.labelsAdded).toEqual(["agent:failed"]);
    expect(r.comments[0]).toContain("not configured");
  });

  it("starts the runner and marks the run as running with agent:working", async () => {
    const start = vi.fn(async () => ({ sessionId: "sesn_1" }));
    const r = await run({ runner: { start } });
    expect(start).toHaveBeenCalledOnce();
    expect(r.run).toMatchObject({ status: "running", sessionId: "sesn_1" });
    expect(r.labelsRemoved).toEqual(["agent:go"]);
    expect(r.labelsAdded).toEqual(["agent:working"]);
  });

  it("stops at the monthly agent run limit without starting the runner", async () => {
    const start = vi.fn();
    const allowAgentRun = vi.fn(async () => false);
    const r = await run({ runner: { start }, usage: { allowReport: vi.fn(), allowAgentRun } });
    expect(allowAgentRun).toHaveBeenCalledWith("default");
    expect(start).not.toHaveBeenCalled();
    expect(r.run).toMatchObject({ status: "rejected", error: "monthly agent run limit" });
    expect(r.labelsRemoved).toEqual(["agent:go"]);
    expect(r.labelsAdded).toEqual(["agent:failed"]);
    expect(r.comments[0]).toContain("limit for this month");
  });

  it("does not count runs that are rejected before the limit check", async () => {
    const allowAgentRun = vi.fn(async () => true);
    await run({ permission: "triage", runner: { start: vi.fn() }, usage: { allowReport: vi.fn(), allowAgentRun } });
    expect(allowAgentRun).not.toHaveBeenCalled();
  });

  it("starts the runner when the limit allows it", async () => {
    const start = vi.fn(async () => ({ sessionId: "sesn_2" }));
    const r = await run({ runner: { start }, usage: { allowReport: vi.fn(), allowAgentRun: async () => true } });
    expect(r.run).toMatchObject({ status: "running", sessionId: "sesn_2" });
  });

  it("marks the run failed when the runner cannot start", async () => {
    const r = await run({ runner: { start: async () => Promise.reject(new Error("quota")) } });
    expect(r.run.status).toBe("failed");
    expect(r.labelsAdded).toEqual(["agent:working", "agent:failed"]);
    expect(r.comments[0]).toContain("could not be started");
  });
});
