/**
 * Removes personal data and secrets from user-submitted text before it is
 * stored or published. Patterns run in order; earlier ones win, so the more
 * specific patterns (secrets, resident registration numbers) come first.
 */

export interface MaskResult {
  text: string;
  redactions: number;
}

interface Rule {
  label: string;
  pattern: RegExp;
  /** Optional extra check on a candidate match. */
  accept?: (match: string) => boolean;
}

const RULES: Rule[] = [
  {
    // GitHub, Anthropic, OpenAI-style, Slack and AWS access keys pasted from logs.
    label: "[secret]",
    pattern:
      /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[ousr]_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
  },
  {
    label: "[email]",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    // Korean resident / foreigner registration number: YYMMDD-NNNNNNN
    label: "[id-number]",
    pattern: /\b\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[- ]?[1-8]\d{6}\b/g,
  },
  {
    label: "[card]",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: (match) => passesLuhn(match.replace(/\D/g, "")),
  },
  {
    // International format, e.g. +82 10-1234-5678, +1 415 555 0100
    label: "[phone]",
    pattern: /\+\d{1,3}[ -]?\(?\d{1,4}\)?[ -]?\d{3,4}[ -]?\d{4}\b/g,
  },
  {
    // Korean mobile and landline numbers, e.g. 010-1234-5678, 02-123-4567
    label: "[phone]",
    pattern: /\b0(?:1[016789]|2|[3-6][1-5]|70)[- ]?\d{3,4}[- ]?\d{4}\b/g,
  },
  {
    label: "[ip]",
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
];

export function maskText(input: string): MaskResult {
  let text = input;
  let redactions = 0;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match) => {
      if (rule.accept && !rule.accept(match)) return match;
      redactions += 1;
      return rule.label;
    });
  }
  return { text, redactions };
}

/** Masks every string value of a record and sums the redactions. */
export function maskFields<T extends { [K in keyof T]: string }>(fields: T): { fields: T; redactions: number } {
  let redactions = 0;
  const out = {} as Record<string, string>;
  for (const [key, value] of Object.entries(fields) as [string, string][]) {
    const result = maskText(value);
    out[key] = result.text;
    redactions += result.redactions;
  }
  return { fields: out as T, redactions };
}

function passesLuhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}
