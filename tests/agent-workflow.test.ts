import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Guards the security properties of the agent workflow template. A change that
 * breaks one of these should be a deliberate decision, not an accident.
 */

const raw = readFileSync(new URL("../templates/workflows/feedback-to-pr-agent.yml", import.meta.url), "utf8");
const workflow = parse(raw) as {
  on: { issues: { types: string[] } };
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if: string;
      permissions: Record<string, string>;
      steps: { name?: string; uses?: string; run?: string; with?: Record<string, string> }[];
    }
  >;
};
const job = workflow.jobs.fix!;
const claudeStep = job.steps.find((s) => s.uses?.startsWith("anthropics/claude-code-action@"))!;

describe("agent workflow template", () => {
  it("runs only when agent:go is added to a feedback-to-pr issue", () => {
    expect(workflow.on).toEqual({ issues: { types: ["labeled"] } });
    expect(job.if).toContain("github.event.label.name == 'agent:go'");
    expect(job.if).toContain("'source:discord'");
  });

  it("grants nothing at the top level and only the needed scopes to the job", () => {
    expect(workflow.permissions).toEqual({});
    expect(job.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
      issues: "write",
      "id-token": "write",
    });
  });

  it("never interpolates issue text into shell scripts", () => {
    // Titles and bodies are attacker-controlled; ${{ }} in run: would be script injection.
    for (const step of job.steps) {
      if (!step.run) continue;
      expect(step.run).not.toMatch(/\$\{\{[^}]*github\.event\.(issue|comment|label)\.(title|body|name)/);
      expect(step.run).not.toMatch(/\$\{\{/);
    }
  });

  it("keeps the prompt free of issue text and marks the untrusted section", () => {
    const prompt = claudeStep.with!.prompt!;
    expect(prompt).not.toMatch(/github\.event\.issue\.(title|body)/);
    expect(prompt).toContain("feedback-to-pr:untrusted-input:start");
    expect(prompt).toContain("Never modify files under .github/");
    expect(prompt).toContain("--draft");
  });

  it("uses a strict tool allow-list without broad shell access", () => {
    const args = claudeStep.with!.claude_args!;
    expect(args).toContain("--permission-mode default");
    const allowed = /--allowedTools "([^"]+)"/.exec(args)?.[1]?.split(",") ?? [];
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed).not.toContain("Bash");
    for (const tool of allowed.filter((t) => t.startsWith("Bash("))) {
      expect(tool).toMatch(/^Bash\((gh|git) [a-z -]+:\*\)$/);
    }
    expect(allowed.some((t) => /WebFetch|WebSearch/.test(t))).toBe(false);
  });

  it("accepts either an API key or a subscription token", () => {
    expect(claudeStep.with!.anthropic_api_key).toBe("${{ secrets.ANTHROPIC_API_KEY }}");
    expect(claudeStep.with!.claude_code_oauth_token).toBe("${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
  });
});
