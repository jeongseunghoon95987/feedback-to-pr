/** Free-text fields a reporter fills in. Always stored after masking. */
export interface ReportFields {
  what: string;
  steps: string;
  expected: string;
  environment: string;
}

/** Where a report came from inside Discord. */
export type ReportKind = "command" | "message";

/** A normalized report, independent of the channel it arrived on. */
export interface FeedbackReport {
  tenantId: string;
  source: "discord";
  kind: ReportKind;
  guildId: string;
  channelId: string;
  /** Set when a moderator reported someone else's message. */
  sourceMessageId: string | null;
  reporterId: string;
  /** Author of the reported message, when kind is "message". */
  reportedAuthorId: string | null;
  title: string;
  fields: ReportFields;
  /** Number of values removed by masking, across title and fields. */
  redactions: number;
}

/** Queue message for the asynchronous processing step. */
export interface ReportJob {
  reportId: number;
  locale: string;
  /** Interaction credentials, valid for 15 minutes after the interaction. */
  interaction: {
    applicationId: string;
    token: string;
  };
}
