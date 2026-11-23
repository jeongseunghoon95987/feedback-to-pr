/** A repository the signed-in GitHub user administers and the GitHub App is installed on. */
export interface RepoCandidate {
  installationId: number;
  owner: string;
  repo: string;
}

export interface ConnectSession {
  linkToken: string;
  browserToken: string | null;
  guildId: string;
  channelId: string;
  discordUserId: string;
  locale: string;
  inviteCode: string | null;
  candidates: RepoCandidate[] | null;
  expiresAt: Date;
  completed: boolean;
}

export type LinkResult = "linked" | "repo_taken" | "invite_used_up" | "already_completed";

/** How long a /connect link and the browser flow stay valid. */
export const CONNECT_SESSION_MINUTES = 30;

export interface ConnectStore {
  /** false when the code does not exist or has no uses left. */
  inviteAvailable(code: string): Promise<boolean>;
  createSession(input: {
    guildId: string;
    channelId: string;
    discordUserId: string;
    locale: string;
    inviteCode: string | null;
  }): Promise<string>;
  /** Marks the link as opened and returns a new browser token, or null if the link is unknown, used or expired. */
  startSession(linkToken: string): Promise<string | null>;
  /** The open (not completed, not expired) session for a browser token. */
  findSession(browserToken: string): Promise<ConnectSession | null>;
  saveCandidates(browserToken: string, candidates: RepoCandidate[]): Promise<void>;
  /** The repository a Discord server is connected to, if any. */
  findGuildRepo(guildId: string): Promise<{ owner: string; repo: string } | null>;
  /** Connects the session's Discord server to the repository, in one transaction. */
  link(session: ConnectSession, repo: RepoCandidate, tenantName: string): Promise<LinkResult>;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** D1 datetime text ('YYYY-MM-DD HH:MM:SS', UTC), comparable with datetime('now'). */
function sqlTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

interface SessionRow {
  link_token: string;
  browser_token: string | null;
  guild_id: string;
  channel_id: string;
  discord_user_id: string;
  locale: string;
  invite_code: string | null;
  candidates: string | null;
  expires_at: string;
  completed_at: string | null;
}

export class D1ConnectStore implements ConnectStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async inviteAvailable(code: string): Promise<boolean> {
    const row = await this.db.prepare("SELECT 1 FROM invite_codes WHERE code = ? AND uses < max_uses").bind(code).first();
    return row !== null;
  }

  async createSession(input: {
    guildId: string;
    channelId: string;
    discordUserId: string;
    locale: string;
    inviteCode: string | null;
  }): Promise<string> {
    const linkToken = randomToken();
    const expires = new Date(this.now().getTime() + CONNECT_SESSION_MINUTES * 60 * 1000);
    await this.db
      .prepare(
        `INSERT INTO connect_sessions (link_token, guild_id, channel_id, discord_user_id, locale, invite_code, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(linkToken, input.guildId, input.channelId, input.discordUserId, input.locale, input.inviteCode, sqlTime(expires))
      .run();
    return linkToken;
  }

  async startSession(linkToken: string): Promise<string | null> {
    const browserToken = randomToken();
    const row = await this.db
      .prepare(
        `UPDATE connect_sessions SET browser_token = ?, started_at = ?
         WHERE link_token = ? AND started_at IS NULL AND completed_at IS NULL AND expires_at > ?
         RETURNING browser_token`,
      )
      .bind(browserToken, sqlTime(this.now()), linkToken, sqlTime(this.now()))
      .first<{ browser_token: string }>();
    return row?.browser_token ?? null;
  }

  async findSession(browserToken: string): Promise<ConnectSession | null> {
    const row = await this.db
      .prepare("SELECT * FROM connect_sessions WHERE browser_token = ? AND completed_at IS NULL AND expires_at > ?")
      .bind(browserToken, sqlTime(this.now()))
      .first<SessionRow>();
    if (!row) return null;
    return {
      linkToken: row.link_token,
      browserToken: row.browser_token,
      guildId: row.guild_id,
      channelId: row.channel_id,
      discordUserId: row.discord_user_id,
      locale: row.locale,
      inviteCode: row.invite_code,
      candidates: row.candidates ? (JSON.parse(row.candidates) as RepoCandidate[]) : null,
      expiresAt: new Date(`${row.expires_at.replace(" ", "T")}Z`),
      completed: row.completed_at !== null,
    };
  }

  async saveCandidates(browserToken: string, candidates: RepoCandidate[]): Promise<void> {
    await this.db
      .prepare("UPDATE connect_sessions SET candidates = ? WHERE browser_token = ? AND completed_at IS NULL")
      .bind(JSON.stringify(candidates), browserToken)
      .run();
  }

  async findGuildRepo(guildId: string): Promise<{ owner: string; repo: string } | null> {
    return this.db
      .prepare(
        `SELECT g.owner, g.repo FROM discord_guilds d JOIN github_repos g ON g.tenant_id = d.tenant_id WHERE d.guild_id = ?`,
      )
      .bind(guildId)
      .first<{ owner: string; repo: string }>();
  }

  async link(session: ConnectSession, repo: RepoCandidate, tenantName: string): Promise<LinkResult> {
    const now = sqlTime(this.now());
    // Claim the session first so a double submit cannot link twice.
    const claimed = await this.db
      .prepare("UPDATE connect_sessions SET completed_at = ? WHERE link_token = ? AND completed_at IS NULL RETURNING link_token")
      .bind(now, session.linkToken)
      .first();
    if (!claimed) return "already_completed";

    const release = () =>
      this.db.prepare("UPDATE connect_sessions SET completed_at = NULL WHERE link_token = ?").bind(session.linkToken).run();

    if (session.inviteCode) {
      const taken = await this.db
        .prepare("UPDATE invite_codes SET uses = uses + 1 WHERE code = ? AND uses < max_uses RETURNING code")
        .bind(session.inviteCode)
        .first();
      if (!taken) {
        await release();
        return "invite_used_up";
      }
    }

    const existing = await this.db
      .prepare("SELECT tenant_id FROM discord_guilds WHERE guild_id = ?")
      .bind(session.guildId)
      .first<{ tenant_id: string }>();
    const tenantId = existing?.tenant_id ?? crypto.randomUUID();

    try {
      await this.db.batch([
        this.db.prepare("INSERT OR IGNORE INTO tenants (id, name) VALUES (?, ?)").bind(tenantId, tenantName),
        this.db
          .prepare("INSERT INTO discord_guilds (guild_id, tenant_id) VALUES (?, ?) ON CONFLICT (guild_id) DO NOTHING")
          .bind(session.guildId, tenantId),
        this.db
          .prepare(
            `INSERT INTO github_repos (tenant_id, installation_id, owner, repo) VALUES (?, ?, ?, ?)
             ON CONFLICT (tenant_id) DO UPDATE SET installation_id = excluded.installation_id, owner = excluded.owner, repo = excluded.repo`,
          )
          .bind(tenantId, repo.installationId, repo.owner, repo.repo),
      ]);
    } catch (error) {
      await release();
      if (session.inviteCode) {
        await this.db.prepare("UPDATE invite_codes SET uses = uses - 1 WHERE code = ?").bind(session.inviteCode).run();
      }
      // The unique index on (owner, repo): another server already connected this repository.
      if (String(error).includes("UNIQUE")) return "repo_taken";
      throw error;
    }
    return "linked";
  }
}
