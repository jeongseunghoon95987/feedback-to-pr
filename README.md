# feedback-to-pr

[한국어](README.ko.md)

> **Status: early development, self-hosted.** Discord reports become triaged GitHub issues, and an `agent:go` label turns an issue into a draft pull request written by a server-side agent (Claude Managed Agents). Not built yet: the report thread in Discord, the reply after merge, per-user rate limits, and the hosted version. See [PLAN.md](PLAN.md) (Korean) for the design.

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
Coding agent        Claude Managed Agents reads the repository and writes a patch;
                    the Worker checks the patch and opens a draft PR as the GitHub App
   │
   ▼
Merge               the bot replies in the reporter's Discord thread (planned)
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

## Agent fix workflow

By default the agent runs on our side: when a maintainer adds `agent:go`, the Worker starts a Claude Managed Agents session with a read-only token for that one repository. The agent never pushes. It leaves a patch, and the Worker validates it (nothing under `.github/`, limits on size and file count) and opens a draft pull request as the GitHub App. Nothing is added to your repository. Design: [docs/design/server-agent.md](docs/design/server-agent.md) (Korean).

As an advanced option, a GitHub Actions workflow does the same inside your own repository with a Claude API key or a Claude subscription token. See [docs/agent-workflow.md](docs/agent-workflow.md).

## Deploy (self-hosted)

You need a Cloudflare account, a Discord application, a GitHub App and a Claude API key. Everything runs in your own accounts.

**1. Discord application** ([developer portal](https://discord.com/developers/applications)): copy the Application ID and Public Key, and create a bot token.

**2. GitHub App** (Settings → Developer settings → GitHub Apps):
- Repository permissions: Issues, Contents and Pull requests: Read and write. Metadata: Read. Do not grant Workflows.
- Webhook: Active, URL `https://<your worker>/github/webhook` (you can fill it in after step 4), a random secret, and subscribe to **Issues** events.
- Generate a private key, then install the app on the target repository and note the installation id (the number at the end of the installation page URL).

**3. Claude**: put `ANTHROPIC_API_KEY` in `.dev.vars` and run `npm run setup-agent` once. It prints `MANAGED_AGENT_ID` and `MANAGED_ENVIRONMENT_ID`.

**4. Cloudflare**

```sh
npm install
npx wrangler login
npx wrangler d1 create feedback-to-pr            # put the printed id in wrangler.toml
npx wrangler queues create feedback-to-pr-reports
npm run db:migrate:remote
cp scripts/seed.example.sql scripts/seed.sql     # set your Discord server id, then add your repository:
#   INSERT INTO github_repos (tenant_id, installation_id, owner, repo) VALUES ('default', <installation id>, '<owner>', '<repo>');
npx wrangler d1 execute feedback-to-pr --remote --file scripts/seed.sql
npm run deploy                                   # prints https://feedback-to-pr.<account>.workers.dev
```

Set the secrets with `npx wrangler secret put <NAME>` (the private key: `npx wrangler secret put GITHUB_APP_PRIVATE_KEY < key.pem`):
`DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `MANAGED_AGENT_ID`, `MANAGED_ENVIRONMENT_ID`, and optionally `AGENT_BUDGET_CENTS`, `TRIAGE_MODEL` and the usage limits `LIMIT_REPORTS_PER_USER_HOUR`, `LIMIT_REPORTS_PER_MONTH` and `LIMIT_AGENT_RUNS_PER_MONTH` (empty means no limit).

**5. Point the services at the Worker**
- Discord portal → General Information → Interactions Endpoint URL: `https://<your worker>/discord/interactions`. Discord checks the URL before saving, so deploy first.
- GitHub App → Webhook URL: `https://<your worker>/github/webhook`.
- Claude Console → Webhooks: add `https://<your worker>/anthropic/webhook` with the events `session.status_idled`, `session.status_terminated` and `session.budget_reached`, then `npx wrangler secret put ANTHROPIC_WEBHOOK_SIGNING_KEY` with the signing key it shows.
- Register the slash command: `npm run register-commands`.

Test it with `/bug` in your server. Short test text is usually classified as spam and closed without an issue; a concrete report creates one. Add `agent:go` to that issue to get a draft pull request. `npx wrangler tail` shows the requests as they arrive.

## Costs

feedback-to-pr itself is free (MIT). When you self-host, you pay Cloudflare and Anthropic directly. Prices below are list prices checked on 2026-11-20; per-report and per-run amounts are estimates, not measurements.

| Item | What it costs | Typical use |
|---|---|---|
| Cloudflare Workers, D1, Queues | Free plan: 100,000 requests a day, 10,000 queue operations a day (about 3 per report), D1 5 GB. Paid plan: $5 a month | A community project fits in the free plan |
| AI triage, once per report | Claude Opus 5.5 at low effort: $4 / $20 per million input / output tokens | About $0.03 per report (estimate, assuming ~3K input and ~1K output tokens) |
| Agent run, once per `agent:go` | Claude Opus 5.5 tokens, plus $0.08 per hour while the session is running | Capped per run by `AGENT_BUDGET_CENTS` (default $2). The run stops when it hits the cap |

To spend less:
- Set `TRIAGE_MODEL=claude-haiku-5-5` ($0.10 / $0.50 per million tokens, well under a cent per report). Triage quality on Haiku has not been measured yet.
- Lower `AGENT_BUDGET_CENTS`. A smaller cap means hard issues may stop without a patch.
- Set usage limits: `LIMIT_REPORTS_PER_USER_HOUR` (per Discord user), `LIMIT_REPORTS_PER_MONTH` (per server) and `LIMIT_AGENT_RUNS_PER_MONTH`. A report over a limit is refused with a private message to the reporter; an `agent:go` over the limit gets a comment and no run.
- Spam is filtered before an issue is created, and agent runs only happen after a maintainer approves.

## Pricing plan for the hosted version (draft)

The hosted version (planned for v0.3) is for people who do not want to deploy anything: click to install the GitHub App and the Discord bot, and connect a channel to a repository. Self-hosting stays free and fully featured. Nothing below is decided yet.

**How money comes in**
- **Monthly subscription** for the service itself: hosting, our GitHub App and Discord bot, the dashboard and support.
- **AI usage** is paid separately, so heavy use can never cost more than it brings in:
  - **Bring your own key** (default): you enter your Claude API key and Anthropic bills you directly. We add no markup.
  - **Credits**: buy prepaid credits instead of managing a key. Usage is charged at list price plus a margin, and each repository has a monthly limit.

**Draft tiers** (example numbers, to be set after measuring real costs)

| | Free | Pro | Team |
|---|---|---|---|
| Price | $0 | about $10 a month | about $30 a month |
| Repositories, Discord servers | 1, 1 | 5, 3 | unlimited |
| Reports triaged per month | 100 | 2,000 | 10,000 |
| Agent runs | own key only | own key or credits | own key or credits, per-repository caps |

**What has to be built first**
- Usage records per tenant: reports, triage tokens, and the cost of each agent session (read from the session's usage when it ends). The tables already carry `tenant_id`.
- Limits enforced per plan before triage and before an agent run starts.
- Billing with a payment provider (such as Stripe), plus encrypted storage for customer API keys.
- Terms of service, a privacy policy and data processing terms. Reports can contain personal data even after masking.

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
