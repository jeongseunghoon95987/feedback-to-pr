import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  Permission,
  ResponseType,
  ephemeral,
  invokingUser,
  type Interaction,
  type InteractionResponse,
} from "../connectors/discord/api";
import type { Messages } from "../core/i18n";
import type { ConnectStore } from "./store";

export const CONNECT_COMMAND = "connect";

export interface ConnectCommandDeps {
  store: ConnectStore;
  /** Public origin of this Worker, without a trailing slash. */
  baseUrl: string;
  /** Closed beta: /connect needs an invite code. */
  inviteRequired: boolean;
}

/** Server admins only. Discord hides the command from others; the check here does not rely on that. */
function canManageServer(interaction: Interaction): boolean {
  const raw = interaction.member?.permissions;
  if (!raw || !/^\d+$/.test(raw)) return false;
  const bits = BigInt(raw);
  return (bits & Permission.ADMINISTRATOR) !== 0n || (bits & Permission.MANAGE_GUILD) !== 0n;
}

export async function handleConnectCommand(
  interaction: Interaction,
  deps: ConnectCommandDeps | null,
  msg: Messages,
): Promise<InteractionResponse> {
  if (!deps) return ephemeral(msg.connectNotConfigured);
  const user = invokingUser(interaction);
  if (!interaction.guild_id || !interaction.channel_id || !user) return ephemeral(msg.guildOnly);
  if (!canManageServer(interaction)) return ephemeral(msg.connectNeedsManageServer);

  let inviteCode: string | null = null;
  if (deps.inviteRequired) {
    const option = interaction.data?.options?.find((o) => o.name === "code")?.value;
    inviteCode = typeof option === "string" ? option.trim() : "";
    if (!inviteCode) return ephemeral(msg.connectInviteRequired);
    if (!(await deps.store.inviteAvailable(inviteCode))) return ephemeral(msg.connectInviteInvalid);
  }

  const current = await deps.store.findGuildRepo(interaction.guild_id);
  const linkToken = await deps.store.createSession({
    guildId: interaction.guild_id,
    channelId: interaction.channel_id,
    discordUserId: user.id,
    locale: interaction.locale ?? "en",
    inviteCode,
  });

  const url = `${deps.baseUrl}/connect/start?t=${encodeURIComponent(linkToken)}`;
  return {
    type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: msg.connectLink(current ? `${current.owner}/${current.repo}` : null),
      flags: MessageFlags.EPHEMERAL,
      allowed_mentions: { parse: [] },
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [{ type: ComponentType.BUTTON, style: ButtonStyle.LINK, label: msg.connectButton, url }],
        },
      ],
    },
  };
}
