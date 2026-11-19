/** User-facing bot messages. Discord sends the user's client locale with each interaction. */

export interface Messages {
  guildOnly: string;
  notConnected: string;
  channelNotAllowed: string;
  modalTitle: string;
  fieldTitle: string;
  fieldWhat: string;
  fieldSteps: string;
  fieldExpected: string;
  fieldEnvironment: string;
  received: (title: string, id: number) => string;
  receivedWithIssue: (title: string, id: number, issueUrl: string) => string;
  receivedDuplicate: (title: string, id: number, issueUrl: string) => string;
  notFiled: (title: string, id: number) => string;
  invalidSubmission: string;
  processingFailed: string;
}

const messages: Record<"en" | "ko", Messages> = {
  en: {
    guildOnly: "Bug reports can only be sent from a server.",
    notConnected: "This server is not connected to a repository yet. Ask a server admin to finish setup.",
    channelNotAllowed: "Bug reports are not accepted in this channel.",
    modalTitle: "Report a bug",
    fieldTitle: "Title",
    fieldWhat: "What happened?",
    fieldSteps: "Steps to reproduce",
    fieldExpected: "What did you expect?",
    fieldEnvironment: "Version / OS / browser",
    received: (title: string, id: number) => `📝 Bug report received: **${title}** (#${id})`,
    receivedWithIssue: (title: string, id: number, issueUrl: string) =>
      `📝 Bug report received: **${title}** (#${id})\n🔗 Tracked in ${issueUrl}`,
    receivedDuplicate: (title: string, id: number, issueUrl: string) =>
      `📝 Bug report received: **${title}** (#${id})\n🔁 This looks like a known problem, so your report was added to ${issueUrl}`,
    notFiled: (title: string, id: number) =>
      `📝 Report **${title}** (#${id}) was not filed as an issue because it did not look like a bug report. If this is a mistake, please send it again with more detail.`,
    invalidSubmission: "That report could not be read. Please try again.",
    processingFailed: "⚠️ This report could not be processed. Please try again in a moment.",
  },
  ko: {
    guildOnly: "버그 신고는 서버에서만 보낼 수 있습니다.",
    notConnected: "이 서버는 아직 저장소와 연결되지 않았습니다. 서버 관리자에게 설정을 요청하세요.",
    channelNotAllowed: "이 채널에서는 버그 신고를 받지 않습니다.",
    modalTitle: "버그 신고",
    fieldTitle: "제목",
    fieldWhat: "어떤 문제가 있었나요?",
    fieldSteps: "재현 절차",
    fieldExpected: "기대한 동작",
    fieldEnvironment: "버전 / OS / 브라우저",
    received: (title: string, id: number) => `📝 버그 신고가 접수되었습니다: **${title}** (#${id})`,
    receivedWithIssue: (title: string, id: number, issueUrl: string) =>
      `📝 버그 신고가 접수되었습니다: **${title}** (#${id})\n🔗 이슈: ${issueUrl}`,
    receivedDuplicate: (title: string, id: number, issueUrl: string) =>
      `📝 버그 신고가 접수되었습니다: **${title}** (#${id})\n🔁 이미 알려진 문제로 보여서 기존 이슈에 신고 내용을 추가했습니다: ${issueUrl}`,
    notFiled: (title: string, id: number) =>
      `📝 신고 **${title}** (#${id})는 버그 신고로 보이지 않아 이슈로 등록하지 않았습니다. 잘못 판단했다면 내용을 조금 더 자세히 적어 다시 보내 주세요.`,
    invalidSubmission: "신고 내용을 읽지 못했습니다. 다시 시도해 주세요.",
    processingFailed: "⚠️ 신고를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  },
};

export function t(locale: string | undefined): Messages {
  return locale?.startsWith("ko") ? messages.ko : messages.en;
}
