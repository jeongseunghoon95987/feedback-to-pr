import type { StoredReport } from "../db/store";
import { OUTPUT_SCHEMA, SYSTEM_PROMPT, buildPrompt, parseTriage, type IssueCandidate, type TriageResult, type Triager } from "./triage";

const OPENAI_CHAT_COMPLETIONS = "https://api.openai.com/v1/chat/completions";

interface ChatCompletion {
  choices?: {
    finish_reason?: string;
    message?: { content?: string | null; refusal?: string | null };
  }[];
}

/**
 * Triage with OpenAI GPT models via the Chat Completions API and strict
 * structured outputs. Uses fetch directly so the Worker needs no extra SDK.
 */
export class OpenAITriager implements Triager {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async triage(report: StoredReport, candidates: IssueCandidate[]): Promise<TriageResult | null> {
    const res = await this.fetchFn(OPENAI_CHAT_COMPLETIONS, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildPrompt(report, candidates) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "triage", strict: true, schema: OUTPUT_SCHEMA },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI triage request failed: ${res.status} ${await res.text()}`);
    }

    const choice = ((await res.json()) as ChatCompletion).choices?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === "length") {
      console.warn(`OpenAI triage for report ${report.id} stopped: ${choice.message?.refusal ? "refusal" : "length"}`);
      return null;
    }
    const content = choice?.message?.content;
    return content ? parseTriage(content, candidates) : null;
  }
}
