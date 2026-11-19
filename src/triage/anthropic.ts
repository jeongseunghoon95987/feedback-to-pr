import Anthropic from "@anthropic-ai/sdk";
import type { StoredReport } from "../db/store";
import { OUTPUT_SCHEMA, SYSTEM_PROMPT, buildPrompt, parseTriage, type IssueCandidate, type TriageResult, type Triager } from "./triage";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

export class ClaudeTriager implements Triager {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string = DEFAULT_CLAUDE_MODEL,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async triage(report: StoredReport, candidates: IssueCandidate[]): Promise<TriageResult | null> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 4000,
      // If a safety classifier declines, let the API retry on its recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // Classification is a simple task; low effort keeps it fast and cheap.
      output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildPrompt(report, candidates) }],
    });

    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
      console.warn(`Claude triage for report ${report.id} stopped: ${response.stop_reason}`);
      return null;
    }
    const text = response.content.find((block) => block.type === "text");
    if (!text || text.type !== "text") return null;
    return parseTriage(text.text, candidates);
  }
}
