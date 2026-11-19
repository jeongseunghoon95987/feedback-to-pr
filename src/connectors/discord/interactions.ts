import { maskFields, maskText } from "../../core/mask";
import { t, type Messages } from "../../core/i18n";
import type { FeedbackReport, ReportFields, ReportJob } from "../../core/types";
import type { GuildConnection, Store } from "../../db/store";
import {
  CommandType,
  ComponentType,
  InteractionType,
  Limits,
  ResponseType,
  TextInputStyle,
  ephemeral,
  invokingUser,
  type Interaction,
  type InteractionResponse,
} from "./api";

export interface InteractionDeps {
  store: Store;
  enqueue: (job: ReportJob) => Promise<void>;
}

const BUG_COMMAND = "bug";
const MODAL_BUG = "bug";
/** Custom id for reporting an existing message: msg:<channel>:<message>:<author> */
const MODAL_MESSAGE_PREFIX = "msg:";

const FIELD = {
  title: "title",
  what: "what",
  steps: "steps",
  expected: "expected",
  environment: "environment",
} as const;

/**
 * Handles one verified interaction. Must return within Discord's 3 second
 * window, so anything slow is pushed to the queue.
 */
export async function handleInteraction(
  interaction: Interaction,
  deps: InteractionDeps,
): Promise<InteractionResponse> {
  if (interaction.type === InteractionType.PING) {
    return { type: ResponseType.PONG };
  }

  const msg = t(interaction.locale);

  if (interaction.type !== InteractionType.APPLICATION_COMMAND && interaction.type !== InteractionType.MODAL_SUBMIT) {
    return ephemeral(msg.invalidSubmission);
  }

  const guild = await checkGuild(interaction, deps.store, msg);
  if ("response" in guild) return guild.response;

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    return openModal(interaction, msg);
  }
  return submitModal(interaction, guild.connection, deps, msg);
}

async function checkGuild(
  interaction: Interaction,
  store: Store,
  msg: Messages,
): Promise<{ connection: GuildConnection } | { response: InteractionResponse }> {
  if (!interaction.guild_id || !interaction.channel_id) return { response: ephemeral(msg.guildOnly) };
  const connection = await store.findGuild(interaction.guild_id);
  if (!connection) return { response: ephemeral(msg.notConnected) };
  if (connection.allowedChannelIds && !connection.allowedChannelIds.includes(interaction.channel_id)) {
    return { response: ephemeral(msg.channelNotAllowed) };
  }
  return { connection };
}

function openModal(interaction: Interaction, msg: Messages): InteractionResponse {
  const data = interaction.data;
  if (data?.type === CommandType.CHAT_INPUT && data.name === BUG_COMMAND) {
    return modal(MODAL_BUG, msg, "");
  }
  if (data?.type === CommandType.MESSAGE && data.target_id) {
    const target = data.resolved?.messages?.[data.target_id];
    if (!target) return ephemeral(msg.invalidSubmission);
    const customId = `${MODAL_MESSAGE_PREFIX}${target.channel_id}:${target.id}:${target.author.id}`;
    return modal(customId, msg, target.content.slice(0, Limits.TEXT_INPUT_VALUE));
  }
  return ephemeral(msg.invalidSubmission);
}

function modal(customId: string, msg: Messages, prefilledWhat: string): InteractionResponse {
  const input = (id: string, label: string, style: number, required: boolean, maxLength: number, value = "") => ({
    type: ComponentType.ACTION_ROW,
    components: [
      {
        type: ComponentType.TEXT_INPUT,
        custom_id: id,
        label,
        style,
        required,
        max_length: maxLength,
        ...(value ? { value } : {}),
      },
    ],
  });

  return {
    type: ResponseType.MODAL,
    data: {
      custom_id: customId,
      title: msg.modalTitle.slice(0, Limits.MODAL_TITLE),
      components: [
        input(FIELD.title, msg.fieldTitle, TextInputStyle.SHORT, true, Limits.REPORT_TITLE),
        input(FIELD.what, msg.fieldWhat, TextInputStyle.PARAGRAPH, true, Limits.TEXT_INPUT_VALUE, prefilledWhat),
        input(FIELD.steps, msg.fieldSteps, TextInputStyle.PARAGRAPH, false, Limits.TEXT_INPUT_VALUE),
        input(FIELD.expected, msg.fieldExpected, TextInputStyle.PARAGRAPH, false, Limits.TEXT_INPUT_VALUE),
        input(FIELD.environment, msg.fieldEnvironment, TextInputStyle.SHORT, false, 200),
      ],
    },
  };
}

async function submitModal(
  interaction: Interaction,
  connection: GuildConnection,
  deps: InteractionDeps,
  msg: Messages,
): Promise<InteractionResponse> {
  const customId = interaction.data?.custom_id ?? "";
  const reporter = invokingUser(interaction);
  const values = collectInputValues(interaction.data?.components ?? []);
  const rawTitle = values.get(FIELD.title)?.trim() ?? "";
  const rawWhat = values.get(FIELD.what)?.trim() ?? "";
  if (!reporter || !rawTitle || !rawWhat) return ephemeral(msg.invalidSubmission);

  let kind: FeedbackReport["kind"] = "command";
  let sourceMessageId: string | null = null;
  let reportedAuthorId: string | null = null;
  if (customId.startsWith(MODAL_MESSAGE_PREFIX)) {
    const [, messageId, authorId] = customId.slice(MODAL_MESSAGE_PREFIX.length).split(":");
    if (!messageId || !authorId) return ephemeral(msg.invalidSubmission);
    kind = "message";
    sourceMessageId = messageId;
    reportedAuthorId = authorId;
  } else if (customId !== MODAL_BUG) {
    return ephemeral(msg.invalidSubmission);
  }

  const title = maskText(rawTitle.slice(0, Limits.REPORT_TITLE));
  const masked = maskFields<ReportFields>({
    what: rawWhat,
    steps: values.get(FIELD.steps)?.trim() ?? "",
    expected: values.get(FIELD.expected)?.trim() ?? "",
    environment: values.get(FIELD.environment)?.trim() ?? "",
  });

  const reportId = await deps.store.insertReport({
    tenantId: connection.tenantId,
    source: "discord",
    kind,
    guildId: interaction.guild_id as string,
    channelId: interaction.channel_id as string,
    sourceMessageId,
    reporterId: reporter.id,
    reportedAuthorId,
    title: title.text,
    fields: masked.fields,
    redactions: title.redactions + masked.redactions,
  });

  await deps.enqueue({
    reportId,
    locale: interaction.locale ?? "en",
    interaction: { applicationId: interaction.application_id, token: interaction.token },
  });

  // Public deferred response: the follow-up message becomes the anchor for the report thread.
  return { type: ResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE };
}

/**
 * Collects text input values from a modal submission. Walks the tree so it
 * works with both Action Row and Label wrappers.
 */
export function collectInputValues(components: unknown[]): Map<string, string> {
  const values = new Map<string, string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.custom_id === "string" && typeof obj.value === "string") {
      values.set(obj.custom_id, obj.value);
    }
    if (Array.isArray(obj.components)) obj.components.forEach(visit);
    if (obj.component) visit(obj.component);
  };
  components.forEach(visit);
  return values;
}
