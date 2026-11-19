import { ClaudeTriager, DEFAULT_CLAUDE_MODEL } from "./anthropic";
import { OpenAITriager } from "./openai";
import type { Triager } from "./triage";

export type TriageProvider = "anthropic" | "openai";

export interface TriageConfig {
  TRIAGE_PROVIDER?: string;
  TRIAGE_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
}

/**
 * Picks the triage provider from configuration. Returns null (triage off)
 * when no provider key is configured; reports are then filed without triage.
 *
 * - TRIAGE_PROVIDER=anthropic (default when ANTHROPIC_API_KEY is set): Claude, default model claude-opus-5-5
 * - TRIAGE_PROVIDER=openai: GPT via Chat Completions; TRIAGE_MODEL is required
 */
export function createTriager(config: TriageConfig): Triager | null {
  const provider = (config.TRIAGE_PROVIDER?.trim().toLowerCase() ||
    (config.ANTHROPIC_API_KEY ? "anthropic" : config.OPENAI_API_KEY ? "openai" : "")) as TriageProvider | "";

  if (provider === "anthropic") {
    if (!config.ANTHROPIC_API_KEY) throw new Error("TRIAGE_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
    return new ClaudeTriager(config.ANTHROPIC_API_KEY, config.TRIAGE_MODEL?.trim() || DEFAULT_CLAUDE_MODEL);
  }
  if (provider === "openai") {
    if (!config.OPENAI_API_KEY) throw new Error("TRIAGE_PROVIDER=openai requires OPENAI_API_KEY");
    if (!config.TRIAGE_MODEL?.trim()) throw new Error("TRIAGE_PROVIDER=openai requires TRIAGE_MODEL (an OpenAI model id)");
    return new OpenAITriager(config.OPENAI_API_KEY, config.TRIAGE_MODEL.trim());
  }
  if (provider) throw new Error(`Unknown TRIAGE_PROVIDER "${provider}" (use "anthropic" or "openai")`);
  return null;
}

export type { Triager, TriageResult, IssueCandidate } from "./triage";
