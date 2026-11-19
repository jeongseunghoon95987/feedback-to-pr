/**
 * The subset of the Discord interactions API this project uses.
 * Reference: https://docs.discord.com/developers/interactions/receiving-and-responding
 */

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const ResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  MODAL: 9,
} as const;

export const CommandType = {
  CHAT_INPUT: 1,
  USER: 2,
  MESSAGE: 3,
} as const;

export const ComponentType = {
  ACTION_ROW: 1,
  TEXT_INPUT: 4,
} as const;

export const TextInputStyle = {
  SHORT: 1,
  PARAGRAPH: 2,
} as const;

export const MessageFlags = {
  EPHEMERAL: 1 << 6,
} as const;

/** Modal limits from the Discord docs. */
export const Limits = {
  MODAL_TITLE: 45,
  CUSTOM_ID: 100,
  TEXT_INPUT_VALUE: 4000,
  REPORT_TITLE: 100,
} as const;

export const DISCORD_API = "https://discord.com/api/v10";

export interface DiscordUser {
  id: string;
  username: string;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  author: DiscordUser;
  attachments?: { id: string; filename: string }[];
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  locale?: string;
  member?: { user: DiscordUser };
  user?: DiscordUser;
  data?: {
    name?: string;
    type?: number;
    target_id?: string;
    custom_id?: string;
    resolved?: { messages?: Record<string, DiscordMessage> };
    components?: unknown[];
  };
}

export interface InteractionResponse {
  type: number;
  data?: Record<string, unknown>;
}

export function ephemeral(content: string): InteractionResponse {
  return {
    type: ResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: MessageFlags.EPHEMERAL, allowed_mentions: { parse: [] } },
  };
}

/** Returns the user who triggered the interaction, in a server or a DM. */
export function invokingUser(interaction: Interaction): DiscordUser | undefined {
  return interaction.member?.user ?? interaction.user;
}
