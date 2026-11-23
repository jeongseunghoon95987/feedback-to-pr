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
  userRateLimited: string;
  monthlyLimitReached: string;
  connectNotConfigured: string;
  connectNeedsManageServer: string;
  connectInviteRequired: string;
  connectInviteInvalid: string;
  connectLink: (currentRepo: string | null) => string;
  connectButton: string;
  connectedAnnouncement: (repo: string) => string;
}

const messages: Record<"en" | "ko", Messages> = {
  en: {
    guildOnly: "Bug reports can only be sent from a server.",
    notConnected: "This server is not connected to a repository yet. A server admin can connect it with /connect.",
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
    userRateLimited: "You have sent several reports in the last hour. Please wait a while before sending another.",
    monthlyLimitReached:
      "This server has reached its report limit for this month, so the report was not sent. Ask a server admin, or try again next month.",
    connectNotConfigured: "Connecting from Discord is not set up on this deployment.",
    connectNeedsManageServer: "Only members with the Manage Server permission can connect this server.",
    connectInviteRequired: "Connecting needs an invite code during the beta. Run `/connect code:<your code>`.",
    connectInviteInvalid: "That invite code is not valid or has no uses left.",
    connectLink: (currentRepo: string | null) =>
      (currentRepo ? `This server is connected to **${currentRepo}**. Finishing again replaces it.\n` : "") +
      "Open the link below within 30 minutes, sign in to GitHub and pick the repository. The link works once and only for you.",
    connectButton: "Connect a GitHub repository",
    connectedAnnouncement: (repo: string) =>
      `✅ This server is now connected to **${repo}**. Bug reports sent with /bug become issues there.`,
  },
  ko: {
    guildOnly: "버그 신고는 서버에서만 보낼 수 있습니다.",
    notConnected: "이 서버는 아직 저장소와 연결되지 않았습니다. 서버 관리자가 /connect로 연결할 수 있습니다.",
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
    userRateLimited: "최근 1시간 동안 신고를 여러 번 보내셨습니다. 잠시 뒤에 다시 보내 주세요.",
    monthlyLimitReached:
      "이 서버는 이번 달 신고 한도에 도달해서 신고를 보내지 않았습니다. 서버 관리자에게 문의하거나 다음 달에 다시 보내 주세요.",
    connectNotConfigured: "이 배포에서는 Discord에서 연결하는 기능이 설정되어 있지 않습니다.",
    connectNeedsManageServer: "서버 관리 권한이 있는 멤버만 이 서버를 연결할 수 있습니다.",
    connectInviteRequired: "베타 기간에는 초대 코드가 필요합니다. `/connect code:<초대 코드>`로 실행하세요.",
    connectInviteInvalid: "초대 코드가 올바르지 않거나 더 사용할 수 없습니다.",
    connectLink: (currentRepo: string | null) =>
      (currentRepo ? `이 서버는 **${currentRepo}**에 연결되어 있습니다. 다시 연결하면 바뀝니다.\n` : "") +
      "30분 안에 아래 링크를 열어 GitHub에 로그인하고 저장소를 고르세요. 링크는 한 번만, 본인만 쓸 수 있습니다.",
    connectButton: "GitHub 저장소 연결",
    connectedAnnouncement: (repo: string) =>
      `✅ 이 서버가 **${repo}**에 연결되었습니다. /bug로 보낸 신고는 이 저장소의 이슈가 됩니다.`,
  },
};

export function t(locale: string | undefined): Messages {
  return locale?.startsWith("ko") ? messages.ko : messages.en;
}
