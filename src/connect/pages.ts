import type { RepoCandidate } from "./store";

type Lang = "en" | "ko";

export function langOf(locale: string | undefined): Lang {
  return locale?.startsWith("ko") ? "ko" : "en";
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const text = {
  en: {
    title: "Connect feedback-to-pr",
    expired: "This link has expired or was already used. Run /connect in your Discord server again.",
    signInFailed: "GitHub sign-in was cancelled or failed. Run /connect in your Discord server again.",
    confirmLead: (guild: string) => `Connect the Discord server <strong>${guild}</strong> to a repository. Bug reports sent with /bug will become issues there.`,
    pick: "Repository",
    connect: "Connect",
    installMore: "Repository not listed? Install the GitHub App on it",
    linked: (repo: string) => `Connected to <strong>${repo}</strong>. You can close this page and go back to Discord.`,
    repoTaken: "That repository is already connected to another Discord server.",
    inviteUsedUp: "The invite code has no uses left.",
    notListed: "That repository is not one you can connect. Start again from Discord.",
    failed: "Something went wrong. Run /connect in your Discord server again.",
  },
  ko: {
    title: "feedback-to-pr 연결",
    expired: "링크가 만료되었거나 이미 사용되었습니다. Discord 서버에서 /connect를 다시 실행하세요.",
    signInFailed: "GitHub 로그인이 취소되었거나 실패했습니다. Discord 서버에서 /connect를 다시 실행하세요.",
    confirmLead: (guild: string) => `Discord 서버 <strong>${guild}</strong>를 저장소에 연결합니다. /bug로 보낸 신고는 이 저장소의 이슈가 됩니다.`,
    pick: "저장소",
    connect: "연결",
    installMore: "원하는 저장소가 없나요? 그 저장소에 GitHub App을 설치하세요",
    linked: (repo: string) => `<strong>${repo}</strong>에 연결되었습니다. 이 페이지를 닫고 Discord로 돌아가세요.`,
    repoTaken: "이 저장소는 이미 다른 Discord 서버에 연결되어 있습니다.",
    inviteUsedUp: "초대 코드를 더 사용할 수 없습니다.",
    notListed: "연결할 수 없는 저장소입니다. Discord에서 다시 시작하세요.",
    failed: "문제가 생겼습니다. Discord 서버에서 /connect를 다시 실행하세요.",
  },
};

export type PageMessage = "expired" | "signInFailed" | "repoTaken" | "inviteUsedUp" | "notListed" | "failed";

function layout(lang: Lang, body: string): string {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${text[lang].title}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1f2328;background:#fff}
h1{font-size:1.25rem}select,button{font:inherit;padding:.4rem .6rem}button{margin-top:1rem}
label{display:block;margin-top:1rem;font-weight:600}a{color:#0969da}
</style>
</head>
<body><h1>${text[lang].title}</h1>${body}</body>
</html>`;
}

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    },
  });

export function messagePage(locale: string | undefined, message: PageMessage, status = 400): Response {
  const lang = langOf(locale);
  return html(layout(lang, `<p>${text[lang][message]}</p>`), status);
}

export function confirmPage(
  locale: string,
  guildName: string,
  candidates: RepoCandidate[],
  formToken: string,
  installHref: string,
): Response {
  const lang = langOf(locale);
  const t = text[lang];
  const options = candidates
    .map((c) => {
      const name = escapeHtml(`${c.owner}/${c.repo}`);
      return `<option value="${name}">${name}</option>`;
    })
    .join("");
  return html(
    layout(
      lang,
      `<p>${t.confirmLead(escapeHtml(guildName))}</p>
<form method="post" action="/connect/github/confirm">
<input type="hidden" name="token" value="${escapeHtml(formToken)}">
<label for="repo">${t.pick}</label>
<select id="repo" name="repo">${options}</select>
<div><button type="submit">${t.connect}</button></div>
</form>
<p><a href="${escapeHtml(installHref)}">${t.installMore}</a></p>`,
    ),
  );
}

export function linkedPage(locale: string, repo: string): Response {
  const lang = langOf(locale);
  return html(layout(lang, `<p>${text[lang].linked(escapeHtml(repo))}</p>`));
}
