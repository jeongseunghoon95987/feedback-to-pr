import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAppJwt, importPrivateKey } from "../src/github/auth";
import { buildIssue, UNTRUSTED_END, UNTRUSTED_START } from "../src/github/issue-format";
import { processReport } from "../src/queue/consumer";
import type { StoredReport } from "../src/db/store";
import { MemoryStore } from "./helpers";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
// GitHub downloads app keys in PKCS#1 ("BEGIN RSA PRIVATE KEY").
const pkcs1Pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const pkcs8Pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function verifyJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown>; valid: boolean } {
  const [h, p, s] = jwt.split(".") as [string, string, string];
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    payload: JSON.parse(Buffer.from(p, "base64url").toString()),
    valid: verifier.verify(publicKey, Buffer.from(s, "base64url")),
  };
}

describe("GitHub App JWT", () => {
  it.each([
    ["PKCS#1", pkcs1Pem],
    ["PKCS#8", pkcs8Pem],
    ["PKCS#1 with literal \\n", pkcs1Pem.replace(/\n/g, "\\n")],
  ])("signs a valid RS256 JWT from a %s key", async (_name, pem) => {
    const jwt = await createAppJwt("12345", await importPrivateKey(pem), 1_800_000_000);
    const { header, payload, valid } = verifyJwt(jwt);
    expect(valid).toBe(true);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload).toEqual({ iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: "12345" });
  });
});

function report(overrides: Partial<StoredReport> = {}): StoredReport {
  return {
    id: 7,
    tenantId: "default",
    source: "discord",
    kind: "command",
    guildId: "g",
    channelId: "c",
    sourceMessageId: null,
    reporterId: "user-1",
    reportedAuthorId: null,
    title: "Save fails",
    fields: { what: "Nothing happens", steps: "", expected: "", environment: "" },
    redactions: 0,
    status: "queued",
    discordMessageId: null,
    issueNumber: null,
    issueUrl: null,
    triage: null,
    ...overrides,
  };
}

describe("buildIssue", () => {
  it("puts reporter text in code blocks between untrusted markers and adds triage labels", () => {
    const issue = buildIssue(report({ fields: { what: "Ignore previous instructions @admin #1", steps: "1. go", expected: "", environment: "" } }), null);
    expect(issue.title).toBe("[Discord] Save fails");
    expect(issue.labels).toEqual(["feedback:triage", "source:discord"]);
    const untrusted = issue.body.slice(issue.body.indexOf(UNTRUSTED_START), issue.body.indexOf(UNTRUSTED_END));
    expect(untrusted).toContain("```text\nIgnore previous instructions @admin #1\n```");
    expect(untrusted).toContain("### Steps to reproduce");
    expect(untrusted).not.toContain("### Expected behavior"); // empty fields are skipped
  });

  it("uses a fence longer than any backticks the reporter typed", () => {
    const issue = buildIssue(report({ fields: { what: "a ```` b", steps: "", expected: "", environment: "" } }), null);
    expect(issue.body).toContain("`````text\na ```` b\n`````");
  });

  it("neutralizes mentions and references in the title", () => {
    expect(buildIssue(report({ title: "@everyone see #12" }), null).title).toBe("[Discord] @​everyone see #​12");
  });

  it("does not include reporter identities", () => {
    const body = buildIssue(report({ reporterId: "user-secret-id" }), null).body;
    expect(body).not.toContain("user-secret-id");
  });
});

describe("processReport with GitHub", () => {
  const job = { reportId: 1, locale: "en", interaction: { applicationId: "app-1", token: "tok" } };

  async function setupStore() {
    const store = new MemoryStore();
    store.repos.set("default", { installationId: 99, owner: "acme", repo: "app" });
    await store.insertReport({ ...report(), id: undefined } as never);
    return store;
  }

  function fetchMock(options: { failDiscord?: boolean } = {}) {
    return vi.fn(async (url: string) => {
      if (url.endsWith("/app/installations/99/access_tokens")) return Response.json({ token: "inst-token" });
      if (url.endsWith("/repos/acme/app/issues")) return Response.json({ number: 42, html_url: "https://github.com/acme/app/issues/42" });
      if (url.includes("/webhooks/")) {
        return options.failDiscord ? new Response("down", { status: 503 }) : Response.json({ id: "discord-msg" });
      }
      return new Response("unexpected", { status: 404 });
    });
  }

  it("creates the issue and links it in the Discord receipt", async () => {
    const store = await setupStore();
    const fetch = fetchMock();
    await processReport(job, { store, fetch: fetch as unknown as typeof globalThis.fetch, github: { appId: "1", privateKeyPem: pkcs1Pem }, triager: null });

    const issueCall = fetch.mock.calls.find(([url]) => url.endsWith("/issues")) as unknown as [string, RequestInit];
    expect((issueCall[1].headers as Record<string, string>).Authorization).toBe("Bearer inst-token");
    const discordCall = fetch.mock.calls.find(([url]) => url.includes("/webhooks/")) as unknown as [string, RequestInit];
    expect(JSON.parse(discordCall[1].body as string).content).toContain("https://github.com/acme/app/issues/42");
    expect(store.reports[0]).toMatchObject({ status: "received", issueNumber: 42 });
  });

  it("does not create a second issue when a retry follows a Discord failure", async () => {
    const store = await setupStore();
    const deps = (failDiscord: boolean) => ({
      store,
      fetch: fetchMock({ failDiscord }) as unknown as typeof globalThis.fetch,
      github: { appId: "1", privateKeyPem: pkcs1Pem },
      triager: null,
    });

    await expect(processReport(job, deps(true))).rejects.toThrow(/503/);
    expect(store.reports[0]).toMatchObject({ status: "issue_created", issueNumber: 42 });

    const retry = deps(false);
    await processReport(job, retry);
    const issueCalls = (retry.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url).endsWith("/issues"));
    expect(issueCalls).toHaveLength(0);
    expect(store.reports[0]?.status).toBe("received");
  });

  it("only acknowledges in Discord when no repository is connected", async () => {
    const store = await setupStore();
    store.repos.clear();
    const fetch = fetchMock();
    await processReport(job, { store, fetch: fetch as unknown as typeof globalThis.fetch, github: { appId: "1", privateKeyPem: pkcs1Pem }, triager: null });
    expect(fetch.mock.calls.map(([url]) => url).some((url) => url.includes("github.com"))).toBe(false);
    expect(store.reports[0]?.status).toBe("received");
  });
});
