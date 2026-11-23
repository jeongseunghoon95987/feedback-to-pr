import { describe, expect, it, vi } from "vitest";
import { CommandType, InteractionType, MessageFlags, ResponseType } from "../src/connectors/discord/api";
import { collectInputValues, handleInteraction } from "../src/connectors/discord/interactions";
import { baseInteraction, setup } from "./helpers";

function modalSubmit(customId: string, values: Record<string, string>) {
  return {
    ...baseInteraction,
    type: InteractionType.MODAL_SUBMIT,
    data: {
      custom_id: customId,
      components: Object.entries(values).map(([id, value]) => ({
        type: 1,
        components: [{ type: 4, custom_id: id, value }],
      })),
    },
  };
}

describe("handleInteraction", () => {
  it("answers PING with PONG", async () => {
    const { deps } = setup();
    expect(await handleInteraction({ ...baseInteraction, type: InteractionType.PING }, deps)).toEqual({
      type: ResponseType.PONG,
    });
  });

  it("rejects servers that are not connected", async () => {
    const { deps } = setup();
    const res = await handleInteraction(
      { ...baseInteraction, guild_id: "other", type: InteractionType.APPLICATION_COMMAND, data: { name: "bug", type: 1 } },
      deps,
    );
    expect(res.type).toBe(ResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(res.data?.flags).toBe(MessageFlags.EPHEMERAL);
  });

  it("rejects channels outside the allow list", async () => {
    const { deps, store } = setup();
    store.guilds.set("guild-1", { tenantId: "default", allowedChannelIds: ["channel-2"] });
    const res = await handleInteraction(
      { ...baseInteraction, type: InteractionType.APPLICATION_COMMAND, data: { name: "bug", type: 1 } },
      deps,
    );
    expect(res.data?.flags).toBe(MessageFlags.EPHEMERAL);
  });

  it("opens a five-field modal for /bug", async () => {
    const { deps } = setup();
    const res = await handleInteraction(
      { ...baseInteraction, type: InteractionType.APPLICATION_COMMAND, data: { name: "bug", type: CommandType.CHAT_INPUT } },
      deps,
    );
    expect(res.type).toBe(ResponseType.MODAL);
    expect(res.data?.custom_id).toBe("bug");
    expect(res.data?.components).toHaveLength(5);
  });

  it("prefills the modal from a right-clicked message", async () => {
    const { deps } = setup();
    const res = await handleInteraction(
      {
        ...baseInteraction,
        type: InteractionType.APPLICATION_COMMAND,
        data: {
          name: "Report as bug",
          type: CommandType.MESSAGE,
          target_id: "msg-9",
          resolved: {
            messages: {
              "msg-9": { id: "msg-9", channel_id: "channel-1", content: "save button broken", author: { id: "author-7", username: "a" } },
            },
          },
        },
      },
      deps,
    );
    expect(res.type).toBe(ResponseType.MODAL);
    expect(res.data?.custom_id).toBe("msg:channel-1:msg-9:author-7");
    expect(JSON.stringify(res.data?.components)).toContain("save button broken");
  });

  it("stores a masked report, enqueues it, and defers the response", async () => {
    const { deps, store, jobs } = setup();
    const res = await handleInteraction(
      modalSubmit("bug", {
        title: "Login fails for jane@example.com",
        what: "Error after entering 010-1234-5678",
        steps: "1. open 2. login",
        expected: "logged in",
        environment: "v1.2 / Windows",
      }),
      deps,
    );

    expect(res).toEqual({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
    expect(store.reports).toHaveLength(1);
    const report = store.reports[0]!;
    expect(report.title).toBe("Login fails for [email]");
    expect(report.fields.what).toBe("Error after entering [phone]");
    expect(report.redactions).toBe(2);
    expect(report.kind).toBe("command");
    expect(jobs).toEqual([
      { reportId: 1, locale: "en-US", interaction: { applicationId: "app-1", token: "token-1" } },
    ]);
  });

  it("records the source message for message reports", async () => {
    const { deps, store } = setup();
    await handleInteraction(modalSubmit("msg:channel-1:msg-9:author-7", { title: "Broken save", what: "details" }), deps);
    expect(store.reports[0]).toMatchObject({ kind: "message", sourceMessageId: "msg-9", reportedAuthorId: "author-7" });
  });

  it("rejects submissions without a title", async () => {
    const { deps, store } = setup();
    const res = await handleInteraction(modalSubmit("bug", { title: " ", what: "x" }), deps);
    expect(res.data?.flags).toBe(MessageFlags.EPHEMERAL);
    expect(store.reports).toHaveLength(0);
  });

  it("checks usage for the tenant and reporter before storing", async () => {
    const { deps, store, jobs } = setup();
    const allowReport = vi.fn(async () => "ok" as const);
    const res = await handleInteraction(modalSubmit("bug", { title: "t", what: "x" }), {
      ...deps,
      usage: { allowReport, allowAgentRun: vi.fn() },
    });
    expect(allowReport).toHaveBeenCalledWith("default", "user-1");
    expect(res).toEqual({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
    expect(store.reports).toHaveLength(1);
    expect(jobs).toHaveLength(1);
  });

  it.each([
    ["user_rate_limited", "last hour"],
    ["monthly_limit", "limit for this month"],
  ] as const)("refuses a report when usage says %s", async (decision, text) => {
    const { deps, store, jobs } = setup();
    const res = await handleInteraction(modalSubmit("bug", { title: "t", what: "x" }), {
      ...deps,
      usage: { allowReport: async () => decision, allowAgentRun: vi.fn() },
    });
    expect(res.data?.flags).toBe(MessageFlags.EPHEMERAL);
    expect(res.data?.content).toContain(text);
    expect(store.reports).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });

  it("does not count submissions that are invalid", async () => {
    const { deps } = setup();
    const allowReport = vi.fn(async () => "ok" as const);
    await handleInteraction(modalSubmit("bug", { title: " ", what: "x" }), { ...deps, usage: { allowReport, allowAgentRun: vi.fn() } });
    expect(allowReport).not.toHaveBeenCalled();
  });

  it("rejects unknown modal ids", async () => {
    const { deps, store } = setup();
    const res = await handleInteraction(modalSubmit("something-else", { title: "t", what: "x" }), deps);
    expect(res.data?.flags).toBe(MessageFlags.EPHEMERAL);
    expect(store.reports).toHaveLength(0);
  });
});

describe("collectInputValues", () => {
  it("reads values wrapped in Label components", () => {
    const values = collectInputValues([{ type: 18, component: { type: 4, custom_id: "title", value: "hi" } }]);
    expect(values.get("title")).toBe("hi");
  });
});
