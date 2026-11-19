# feedback-to-pr

[한국어](README.ko.md)

> **Status: early development.** Discord reports become GitHub issues (signature check, `/bug` and message reports, masking, queue, GitHub App issue creation). AI triage, the report thread and agent runs are not built yet. See [PLAN.md](PLAN.md) (Korean) for the design.

Turn bug reports from your Discord community into clean GitHub issues, let an AI coding agent open a pull request once a maintainer approves, and tell the reporter when the fix ships.

## Why

Coding agents can already turn issues into pull requests, and tools like Slack, Jira and Linear already connect to them. Those are **internal** tools: the people writing there are your teammates.

Bug reports from users arrive somewhere else: a Discord server, a support chat, a feedback form. That input is **untrusted**. It can contain personal data, spam, duplicates, or text written to manipulate an AI agent. feedback-to-pr sits between that input and your repository and makes the handoff safe.

## How it works

```
Discord  /bug  or  right-click → "Report as bug"
   │
   ▼
Cloudflare Worker   verify signature → mask personal data → rate limit
   │  (queue)
   ▼
Triage              summarize, classify (bug / feature / question / spam),
                    find duplicates → create or comment on a GitHub issue
   │
   ▼
GitHub issue        a maintainer adds the `agent:go` label   ← human approval
   │
   ▼
GitHub Actions      your coding agent (e.g. Claude Code Action) opens a PR
   │
   ▼
Merge               the bot replies in the reporter's Discord thread
```

## Principles

- **Reports are data, never instructions.** The original text is quoted as untrusted input, and the agent is told not to follow anything inside it.
- **No agent run without a human.** Nothing touches code until a maintainer applies the approval label.
- **Personal data stays out of issues.** Emails, phone numbers and similar data are masked before an issue is created.
- **Least privilege.** The job that runs PR code gets no secrets. The GitHub App asks only for the permissions it needs.
- **Bring your own agent.** feedback-to-pr prepares the issue; you choose which coding agent writes the fix.

## Planned scope

**v0.1 (self-hosted)**
- Discord: `/bug` modal and message context menu
- Personal data masking and per-user rate limits
- AI triage and duplicate detection
- GitHub App authentication
- Approval-label workflow template
- Replies in a Discord thread when the PR opens and merges
- English and Korean setup guides

**Later**
- Web feedback form, Channel Talk, Intercom, email
- A hosted version with one-click GitHub App and Discord installs

## Development

Requires Node.js 22+ and a Cloudflare account.

```sh
npm install
cp .dev.vars.example .dev.vars          # fill in your Discord application values
npx wrangler d1 create feedback-to-pr   # put the printed id in wrangler.toml
npx wrangler queues create feedback-to-pr-reports
npm run db:migrate:local
cp scripts/seed.example.sql scripts/seed.sql   # set your server id
npx wrangler d1 execute feedback-to-pr --local --file scripts/seed.sql
npm run register-commands
npm run dev
```

To file issues, create a GitHub App (Repository permissions → Issues: Read and write; webhook off), install it on the target repository, and:

- put `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in `.dev.vars` (the downloaded `.pem` on one line, line breaks written as `\n`; in production use `wrangler secret put GITHUB_APP_PRIVATE_KEY < key.pem`)
- connect the repository: `INSERT INTO github_repos (tenant_id, installation_id, owner, repo) VALUES ('default', <installation id>, '<owner>', '<repo>');`

Without a connected repository, reports are still acknowledged in Discord but no issue is filed.

Discord needs a public HTTPS URL for the interactions endpoint (`/discord/interactions`). For local testing, expose `npm run dev` with a tunnel such as `cloudflared tunnel --url http://localhost:8787` and set that URL in the Discord developer portal.

```sh
npm test            # unit tests
npm run typecheck
```

## Built with

Cloudflare Workers, Queues and D1 · TypeScript · GitHub App · Claude API for triage

## License

[MIT](LICENSE)
