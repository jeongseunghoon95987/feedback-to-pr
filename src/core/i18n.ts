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
  invalidSubmission: string;
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
    invalidSubmission: "That report could not be read. Please try again.",
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
    invalidSubmission: "신고 내용을 읽지 못했습니다. 다시 시도해 주세요.",
  },
};

export function t(locale: string | undefined): Messages {
  return locale?.startsWith("ko") ? messages.ko : messages.en;
}
