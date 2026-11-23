import { describe, expect, it, vi } from "vitest";
import { InteractionType, MessageFlags } from "../src/connectors/discord/api";
import { handleInteraction } from "../src/connectors/discord/interactions";
import { CONNECT_COOKIE, afterInstall, confirmConnect, oauthCallback, startConnect, type ConnectDeps } from "../src/connect/flow";
import type { ConnectSession, ConnectStore, LinkResult, RepoCandidate } from "../src/connect/store";
import { baseInteraction, setup } from "./helpers";

class MemoryConnectStore implements ConnectStore {
  invites = new Map<string, number>();
  sessions: (ConnectSession & { started: boolean })[] = [];
  guildRepos = new Map<string, { owner: string; repo: string }>();
  linked: { guildId: string; repo: RepoCandidate; tenantName: string }[] = [];
  linkResult: LinkResult = "linked";
  private counter = 0;

  async inviteAvailable(code: string) {
    return (this.invites.get(code) ?? 0) > 0;
  }
  async createSession(input: { guildId: string; channelId: string; discordUserId: string; locale: string; inviteCode: string | null }) {
    const linkToken = `link-${++this.counter}`;
    this.sessions.push({
      ...input,
      linkToken,
      browserToken: null,
      candidates: null,
      expiresAt: new Date(Date.now() + 60_000),
      completed: false,
      started: false,
    });
    return linkToken;
  }
  async startSession(linkToken: string) {
    const session = this.sessions.find((s) => s.linkToken === linkToken && !s.started && !s.completed);
    if (!session) return null;
    session.started = true;
    session.browserToken = `browser-${++this.counter}`;
    return session.browserToken;
  }
  async findSession(browserToken: string) {
    return this.sessions.find((s) => s.browserToken === browserToken && !s.completed) ?? null;
  }
  async saveCandidates(browserToken: string, candidates: RepoCandidate[]) {
    const session = this.sessions.find((s) => s.browserToken === browserToken);
    if (session) session.candidates = candidates;
  }
  async findGuildRepo(guildId: string) {
    return this.guildRepos.get(guildId) ?? null;
  }
  async link(session: ConnectSession, repo: RepoCandidate, tenantName: string) {
    if (this.linkResult !== "linked") return this.linkResult;
    const stored = this.sessions.find((s) => s.linkToken === session.linkToken)!;
    if (stored.completed) return "already_completed" as const;
    stored.completed = true;
    this.linked.push({ guildId: session.guildId, repo, tenantName });
    return "linked" as const;
  }
}

const MANAGE_GUILD = String(1 << 5);
const ADMINISTRATOR = String(1 << 3);

function connectCommand(options: { permissions?: string; code?: string; guildId?: string } = {}) {
  return {
    ...baseInteraction,
    guild_id: options.guildId ?? "guild-new",
    type: InteractionType.APPLICATION_COMMAND,
    member: { user: { id: "admin-1", username: "admin" }, permissions: options.permissions ?? MANAGE_GUILD },
    data: {
      name: "connect",
      type: 1,
      ...(options.code !== undefined ? { options: [{ name: "code", type: 3, value: options.code }] } : {}),
    },
  };
}

function commandDeps(store: MemoryConnectStore, inviteRequired = false) {
  return { ...setup().deps, connect: { store, baseUrl: "https://worker.example", inviteRequired } };
}

describe("/connect command", () => {
  it("says so when this deployment does not offer /connect", async () => {
    const res = await handleInteraction(connectCommand(), setup().deps);
    expect(res.data?.content).toContain("not set up");
  });

  it("works in a server that is not connected yet and replies with a private one-time link", async () => {
    const store = new MemoryConnectStore();
    const res = await handleInteraction(connectCommand(), commandDeps(store));
    expect(res.data?.flags).toBe(MessageFlags.EPHEMERAL);
    const button = (res.data?.components as { components: { url: string }[] }[])[0]!.components[0]!;
    expect(button.url).toBe("https://worker.example/connect/start?t=link-1");
    expect(store.sessions[0]).toMatchObject({ guildId: "guild-new", channelId: "channel-1", discordUserId: "admin-1", inviteCode: null });
  });

  it.each([
    ["no permissions", "0"],
    ["missing permissions", undefined],
    ["send messages only", String(1 << 11)],
  ])("refuses members without Manage Server (%s)", async (_label, permissions) => {
    const store = new MemoryConnectStore();
    const interaction = connectCommand();
    interaction.member = { user: interaction.member.user, permissions: permissions as string };
    const res = await handleInteraction(interaction, commandDeps(store));
    expect(res.data?.content).toContain("Manage Server");
    expect(store.sessions).toHaveLength(0);
  });

  it("accepts administrators", async () => {
    const store = new MemoryConnectStore();
    await handleInteraction(connectCommand({ permissions: ADMINISTRATOR }), commandDeps(store));
    expect(store.sessions).toHaveLength(1);
  });

  it("mentions the current repository when the server is already connected", async () => {
    const store = new MemoryConnectStore();
    store.guildRepos.set("guild-new", { owner: "acme", repo: "app" });
    const res = await handleInteraction(connectCommand(), commandDeps(store));
    expect(res.data?.content).toContain("acme/app");
  });

  it("requires a valid invite code when the deployment asks for one", async () => {
    const store = new MemoryConnectStore();
    store.invites.set("BETA1", 1);
    const deps = commandDeps(store, true);

    expect((await handleInteraction(connectCommand(), deps)).data?.content).toContain("invite code");
    expect((await handleInteraction(connectCommand({ code: "WRONG" }), deps)).data?.content).toContain("not valid");
    expect(store.sessions).toHaveLength(0);

    await handleInteraction(connectCommand({ code: " BETA1 " }), deps);
    expect(store.sessions[0]?.inviteCode).toBe("BETA1");
  });
});

/** Fake GitHub and Discord APIs for the browser flow. */
function flowDeps(store: MemoryConnectStore, options: { repos?: { owner: string; name: string; admin: boolean }[]; guildName?: string } = {}) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "ghu_user" });
    if (url.includes("/user/installations?")) return Response.json({ installations: [{ id: 55 }] });
    if (url.includes("/user/installations/55/repositories")) {
      return Response.json({
        repositories: (options.repos ?? [{ owner: "acme", name: "app", admin: true }]).map((r) => ({
          name: r.name,
          owner: { login: r.owner },
          permissions: { admin: r.admin },
        })),
      });
    }
    if (url.includes("/applications/client-1/token")) return new Response(null, { status: 204 });
    if (url.includes("/guilds/")) return Response.json({ name: options.guildName ?? "My Server" });
    if (url.endsWith("/access_tokens")) return Response.json({ token: "ghs_install" });
    if (url.endsWith("/labels")) return Response.json({}, { status: 201 });
    if (url.includes("/channels/")) return Response.json({ id: "m1" });
    return new Response("unexpected", { status: 500 });
  });
  const deps: ConnectDeps = {
    store,
    oauth: { clientId: "client-1", clientSecret: "secret-1", slug: "feedback-to-pr" },
    baseUrl: "https://worker.example",
    github: null,
    discordBotToken: "bot",
    fetch: fetchMock as unknown as typeof fetch,
  };
  return { deps, calls };
}

async function startedSession(store: MemoryConnectStore) {
  const linkToken = await store.createSession({ guildId: "g1", channelId: "c1", discordUserId: "u1", locale: "en-US", inviteCode: null });
  const browserToken = (await store.startSession(linkToken))!;
  return { linkToken, browserToken };
}

describe("connect browser flow", () => {
  it("opens a link once: sets a secure cookie and sends the user to GitHub sign-in with it as state", async () => {
    const store = new MemoryConnectStore();
    const linkToken = await store.createSession({ guildId: "g1", channelId: "c1", discordUserId: "u1", locale: "en", inviteCode: null });
    const { deps } = flowDeps(store);

    const res = await startConnect(linkToken, deps);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("redirect_uri")).toBe("https://worker.example/connect/github/callback");
    const browserToken = location.searchParams.get("state")!;
    expect(res.headers.get("Set-Cookie")).toBe(
      `${CONNECT_COOKIE}=${browserToken}; Path=/; Max-Age=1800; HttpOnly; Secure; SameSite=Lax`,
    );

    const again = await startConnect(linkToken, deps);
    expect(again.status).toBe(400);
    expect(again.headers.get("Set-Cookie")).toBeNull();
  });

  it("rejects unknown links", async () => {
    const res = await startConnect("made-up", flowDeps(new MemoryConnectStore()).deps);
    expect(res.status).toBe(400);
  });

  it("rejects a callback whose state does not match the cookie, before talking to GitHub", async () => {
    const store = new MemoryConnectStore();
    const { browserToken } = await startedSession(store);
    const { deps, calls } = flowDeps(store);
    expect((await oauthCallback(browserToken, { state: "other", code: "c" }, deps)).status).toBe(400);
    expect((await oauthCallback(undefined, { state: browserToken, code: "c" }, deps)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("explains a cancelled GitHub sign-in", async () => {
    const store = new MemoryConnectStore();
    const { browserToken } = await startedSession(store);
    const res = await oauthCallback(browserToken, { state: browserToken, error: "access_denied" }, flowDeps(store).deps);
    expect(await res.text()).toContain("cancelled");
  });

  it("lists only repositories the user administers, revokes the user token and escapes the server name", async () => {
    const store = new MemoryConnectStore();
    const { browserToken } = await startedSession(store);
    const { deps, calls } = flowDeps(store, {
      repos: [
        { owner: "acme", name: "app", admin: true },
        { owner: "acme", name: "docs", admin: false },
      ],
      guildName: "<script>x</script>",
    });

    const res = await oauthCallback(browserToken, { state: browserToken, code: "code-1" }, deps);
    const page = await res.text();
    expect(res.status).toBe(200);
    expect(page).toContain('value="acme/app"');
    expect(page).not.toContain("acme/docs");
    expect(page).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(page).not.toContain("<script>");
    expect(store.sessions[0]?.candidates).toEqual([{ installationId: 55, owner: "acme", repo: "app" }]);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/applications/client-1/token"))).toBe(true);
    expect(calls.find((c) => c.url.endsWith("/access_token"))?.body).toMatchObject({ client_secret: "secret-1", code: "code-1" });
  });

  it("sends the user to install the app when no repository can be connected yet", async () => {
    const store = new MemoryConnectStore();
    const { browserToken } = await startedSession(store);
    const res = await oauthCallback(browserToken, { state: browserToken, code: "c" }, flowDeps(store, { repos: [] }).deps);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://github.com/apps/feedback-to-pr/installations/new");
  });

  it("signs in again after installing, ignoring the installation_id GitHub appends", async () => {
    const store = new MemoryConnectStore();
    const { browserToken } = await startedSession(store);
    const { deps } = flowDeps(store);
    const res = await afterInstall(browserToken, deps);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("state")).toBe(browserToken);
    expect((await afterInstall(undefined, deps)).status).toBe(400);
  });

  describe("confirm", () => {
    async function readySession(store: MemoryConnectStore) {
      const { browserToken } = await startedSession(store);
      await store.saveCandidates(browserToken, [{ installationId: 55, owner: "acme", repo: "app" }]);
      return browserToken;
    }

    it("links the server, announces it in the channel and clears the cookie", async () => {
      const store = new MemoryConnectStore();
      const browserToken = await readySession(store);
      const { deps, calls } = flowDeps(store);

      const res = await confirmConnect(browserToken, { token: browserToken, repo: "ACME/app" }, deps);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("acme/app");
      expect(store.linked).toEqual([{ guildId: "g1", repo: { installationId: 55, owner: "acme", repo: "app" }, tenantName: "My Server" }]);
      const announce = calls.find((c) => c.url.endsWith("/channels/c1/messages"));
      expect(announce?.body).toMatchObject({ allowed_mentions: { parse: [] } });
      expect((announce?.body as { content: string }).content).toContain("acme/app");
      expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    });

    it("rejects a form whose token does not match the cookie (CSRF)", async () => {
      const store = new MemoryConnectStore();
      const browserToken = await readySession(store);
      const res = await confirmConnect(browserToken, { token: "forged", repo: "acme/app" }, flowDeps(store).deps);
      expect(res.status).toBe(400);
      expect(store.linked).toHaveLength(0);
    });

    it("rejects a repository that was not in the verified list", async () => {
      const store = new MemoryConnectStore();
      const browserToken = await readySession(store);
      const res = await confirmConnect(browserToken, { token: browserToken, repo: "victim/private" }, flowDeps(store).deps);
      expect(await res.text()).toContain("not one you can connect");
      expect(store.linked).toHaveLength(0);
    });

    it("refuses a repository another server already connected", async () => {
      const store = new MemoryConnectStore();
      store.linkResult = "repo_taken";
      const browserToken = await readySession(store);
      const res = await confirmConnect(browserToken, { token: browserToken, repo: "acme/app" }, flowDeps(store).deps);
      expect(res.status).toBe(409);
      expect(await res.text()).toContain("another Discord server");
    });

    it("cannot be completed twice", async () => {
      const store = new MemoryConnectStore();
      const browserToken = await readySession(store);
      const { deps } = flowDeps(store);
      await confirmConnect(browserToken, { token: browserToken, repo: "acme/app" }, deps);
      const second = await confirmConnect(browserToken, { token: browserToken, repo: "acme/app" }, deps);
      expect(second.status).toBe(400);
      expect(store.linked).toHaveLength(1);
    });
  });
});
