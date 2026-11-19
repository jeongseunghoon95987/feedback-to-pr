# Agent fix workflow (advanced, self-hosted)

> **Planned default:** feedback-to-pr will run the coding agent on its own side, so a connected repository needs no workflow file or secrets. This GitHub Actions workflow is the advanced alternative for people who want the agent to run in their own repository, for example to use a Claude subscription instead of an API key.

feedback-to-pr files issues. This optional workflow lets a maintainer hand an issue to Claude Code with one label: Claude implements a fix on a new branch and opens a **draft** pull request for review.

```
issue (source:discord) ──maintainer adds agent:go──▶ GitHub Actions
   ▲                                                  │ Claude Code reads the issue,
   │                                                  │ fixes, pushes a branch,
   └── labels: agent:working → agent:done / failed ◀──┘ opens a draft PR (or comments)
```

## Setup

All steps happen in the repository that receives the issues, not in feedback-to-pr.

1. **Install the Claude GitHub App** on that repository: <https://github.com/apps/claude>
2. **Add one repository secret** (Settings → Secrets and variables → Actions):

   | Secret | When to use |
   |---|---|
   | `ANTHROPIC_API_KEY` | You pay per use with a Claude API key. Recommended for shared or organization repositories. |
   | `CLAUDE_CODE_OAUTH_TOKEN` | You have a Claude subscription (Pro, Max and others). Create the token with `claude setup-token`. It is tied to the subscription of the person who created it. |

3. **Copy the workflow** [`templates/workflows/feedback-to-pr-agent.yml`](../templates/workflows/feedback-to-pr-agent.yml) to `.github/workflows/feedback-to-pr-agent.yml`.
4. **Create the labels** `agent:go`, `agent:working`, `agent:done`, `agent:failed`:

   ```sh
   gh label create agent:go      --color 0E8A16 --description "Hand this issue to the coding agent"
   gh label create agent:working --color FBCA04 --description "Coding agent is working on it"
   gh label create agent:done    --color 1D76DB --description "Coding agent finished"
   gh label create agent:failed  --color B60205 --description "Coding agent run failed"
   ```

## Using it

1. Read the issue. Check the original report section, not only the AI summary.
2. Add the `agent:go` label.
3. The label is replaced by `agent:working` while the run is in progress, then by `agent:done` or `agent:failed`.
4. Review the draft pull request like any other contribution. If Claude could not find a safe fix, it comments on the issue instead.

To try again, add `agent:go` again.

## Security

The issue text comes from people outside the project. The workflow is built around that:

- **Human approval.** Nothing runs until someone adds `agent:go`. Adding labels needs triage access, and claude-code-action also refuses triggers from users without write access.
- **Untrusted input is marked.** feedback-to-pr wraps the report in code blocks between `feedback-to-pr:untrusted-input` markers. The prompt tells Claude to treat that section and the AI summary as data and to ignore instructions inside them.
- **Narrow tools.** `--permission-mode default` with an explicit `--allowedTools` list: read and edit files, view and comment on the issue, git commit and push, open a PR. No arbitrary shell commands, no network tools.
- **No workflow edits.** The prompt forbids changes under `.github/`.
- **Draft PRs only.** A human reviews and merges.
- **Minimal permissions.** `permissions: {}` at the top level; the job asks only for contents, pull requests, issues and the token claude-code-action needs to authenticate.

What these measures do not cover:

- Prompt-injection defenses lower the risk; they do not remove it. Read the report before approving.
- If you add test commands to `--allowedTools`, they run your repository's code inside a job that holds the Claude secret. Allow only commands you would run on an untrusted branch yourself.
- On public repositories, Actions logs are public.
