import { describe, expect, it, vi } from "vitest";
import { MAX_RETRIES, consumeBatch, processReport } from "../src/queue/consumer";
import type { ReportJob } from "../src/core/types";
import { MemoryStore } from "./helpers";

const job = { reportId: 1, locale: "ko", interaction: { applicationId: "app-1", token: "token-1" } };

async function storeWithReport() {
  const store = new MemoryStore();
  await store.insertReport({
    tenantId: "default",
    source: "discord",
    kind: "command",
    guildId: "guild-1",
    channelId: "channel-1",
    sourceMessageId: null,
    reporterId: "user-1",
    reportedAuthorId: null,
    title: "Save fails",
    fields: { what: "x", steps: "", expected: "", environment: "" },
    redactions: 0,
  });
  return store;
}

describe("processReport", () => {
  it("edits the deferred response without allowing mentions and marks the report received", async () => {
    const store = await storeWithReport();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "discord-msg-1" }), { status: 200 }));

    await processReport(job, { store, fetch: fetchMock as unknown as typeof fetch, github: null });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/v10/webhooks/app-1/token-1/messages/@original");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body as string);
    expect(body.content).toContain("Save fails");
    expect(body.content).toContain("#1");
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(store.reports[0]).toMatchObject({ status: "received", discordMessageId: "discord-msg-1" });
  });

  it("throws so the queue retries when Discord fails", async () => {
    const store = await storeWithReport();
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }));
    await expect(processReport(job, { store, fetch: fetchMock as unknown as typeof fetch, github: null })).rejects.toThrow(/429/);
    expect(store.reports[0]?.status).toBe("queued");
  });

  it("retries on early failures and posts a failure notice on the last attempt", async () => {
    const store = await storeWithReport();
    const calls: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const content = JSON.parse(init.body as string).content as string;
      calls.push(content);
      // The receipt edit fails; the failure notice succeeds.
      return content.startsWith("⚠️")
        ? new Response(JSON.stringify({ id: "m" }), { status: 200 })
        : new Response("boom", { status: 500 });
    });
    const message = (attempts: number) => ({ body: job as ReportJob, attempts, ack: vi.fn(), retry: vi.fn() });
    const deps = { store, fetch: fetchMock as unknown as typeof fetch, github: null };

    const early = message(1);
    await consumeBatch({ messages: [early] } as unknown as MessageBatch<ReportJob>, deps);
    expect(early.retry).toHaveBeenCalled();
    expect(early.ack).not.toHaveBeenCalled();

    const last = message(MAX_RETRIES + 1);
    await consumeBatch({ messages: [last] } as unknown as MessageBatch<ReportJob>, deps);
    expect(last.retry).not.toHaveBeenCalled();
    expect(last.ack).toHaveBeenCalled();
    expect(calls.at(-1)).toContain("처리하지 못했습니다");
  });

  it("skips reports that were already handled", async () => {
    const store = await storeWithReport();
    await store.markReceived(1, "existing");
    const fetchMock = vi.fn();
    await processReport(job, { store, fetch: fetchMock as unknown as typeof fetch, github: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
