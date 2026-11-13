import { renderForModel, type LedgerEntry, type ToolRunner } from "../tools/registry";
import type { ChatMessage, LlmClient } from "./llm";
import { REPORT_INSTRUCTIONS, SYSTEM_PROMPT, TRIAGE_PROMPT } from "./prompts";
import { parseReport, parseTriage, REPORT_JSON_SCHEMA, TRIAGE_JSON_SCHEMA, type Report, type Triage } from "./report";
import { verifyReport, type Verification } from "./verify";

const MAX_CALLS_PER_ROUND = 4;
const REPORT_ATTEMPTS = 2;

export type InvestigationEvent =
  | { type: "tool"; entry: LedgerEntry }
  | { type: "nudge"; message: string }
  | { type: "report_retry"; error: string };

export interface InvestigateDeps {
  llm: LlmClient;
  runner: ToolRunner;
  maxToolRounds?: number;
  onEvent?: (event: InvestigationEvent) => void;
}

export interface InvestigationResult {
  question: string;
  model: string;
  triage: Triage;
  report: Report | null;
  reportError?: string;
  verification: Verification | null;
  ledger: readonly LedgerEntry[];
  toolRounds: number;
  durationMs: number;
}

/**
 * Three phases. Triage sees only the user's question and decides whether to refuse, so
 * untrusted Stripe data can never influence that decision. Then the model gathers evidence
 * with tools, and finally writes a schema-constrained report. Keeping tool calling and
 * structured output in separate requests also suits small local models.
 */
export async function investigate(question: string, deps: InvestigateDeps): Promise<InvestigationResult> {
  const started = Date.now();
  const { llm, runner, maxToolRounds = 6, onEvent } = deps;

  const triage = await triageRequest(question, llm);
  if (triage.action === "refuse") return refusalResult(question, llm.model, triage, runner, started);

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: question },
  ];

  let toolRounds = 0;
  const gatherEvidence = async () => {
    while (toolRounds < maxToolRounds) {
      const reply = await llm.chat({ messages, tools: runner.specs() });
      messages.push(reply);
      const calls = reply.tool_calls ?? [];
      if (calls.length === 0) return;
      toolRounds++;
      for (const call of calls.slice(0, MAX_CALLS_PER_ROUND)) {
        const entry = await runner.call(call.function.name, call.function.arguments);
        onEvent?.({ type: "tool", entry });
        messages.push({ role: "tool", tool_name: call.function.name, content: renderForModel(entry) });
      }
    }
  };

  await gatherEvidence();
  const skipped = unfetchedCharges(runner.ledger);
  if (skipped.length > 0 && toolRounds < maxToolRounds) {
    const message = `Before concluding: you have not retrieved charge ${skipped.join(", ")}. The charge outcome shows whether Stripe Radar blocked the payment or the card issuer declined it. Retrieve it now.`;
    onEvent?.({ type: "nudge", message });
    messages.push({ role: "user", content: message });
    await gatherEvidence();
  }

  messages.push({ role: "user", content: REPORT_INSTRUCTIONS });
  let report: Report | null = null;
  let reportError: string | undefined;
  for (let attempt = 0; attempt < REPORT_ATTEMPTS && report === null; attempt++) {
    const reply = await llm.chat({ messages, format: REPORT_JSON_SCHEMA });
    const parsed = parseReport(reply.content);
    if (parsed.ok) {
      report = parsed.value;
      reportError = undefined;
    } else {
      reportError = parsed.error;
      onEvent?.({ type: "report_retry", error: parsed.error });
      messages.push(
        { role: "assistant", content: reply.content },
        { role: "user", content: `That report was invalid: ${parsed.error}. Return only JSON that matches the schema.` },
      );
    }
  }

  return {
    question,
    model: llm.model,
    triage,
    report,
    ...(reportError ? { reportError } : {}),
    verification: report ? verifyReport(report, runner.ledger) : null,
    ledger: runner.ledger,
    toolRounds,
    durationMs: Date.now() - started,
  };
}

export function refusalResult(
  question: string,
  model: string,
  triage: Triage,
  runner: ToolRunner,
  started: number,
): InvestigationResult {
  const report: Report = {
    evidence: [],
    unknowns: [],
    root_cause: "request_refused",
    certainty: "confirmed",
    answer: `I can't do that. ${triage.reason} I'm a read-only investigator: I can explain what happened to a payment, but I can't change it or reveal sensitive card data.`,
    next_steps: [],
  };
  return {
    question,
    model,
    triage,
    report,
    verification: verifyReport(report, runner.ledger),
    ledger: runner.ledger,
    toolRounds: 0,
    durationMs: Date.now() - started,
  };
}

/**
 * Fails open to "investigate": the agent has no write tools, so the worst case of a
 * missed refusal is a read-only investigation the user did not ask for.
 */
async function triageRequest(question: string, llm: LlmClient): Promise<Triage> {
  const reply = await llm.chat({
    messages: [
      { role: "system", content: TRIAGE_PROMPT },
      { role: "user", content: question },
    ],
    format: TRIAGE_JSON_SCHEMA,
  });
  const parsed = parseTriage(reply.content);
  return parsed.ok ? parsed.value : TRIAGE_FALLBACK;
}

export const TRIAGE_FALLBACK: Triage = {
  action: "investigate",
  reason: "Triage output was invalid; defaulting to a read-only investigation.",
};

/**
 * Charges referenced by a retrieved PaymentIntent that the agent never looked at.
 * The PaymentIntent alone cannot distinguish a Radar block from an issuer decline.
 */
export function unfetchedCharges(ledger: readonly LedgerEntry[]): string[] {
  const attempted = new Set(
    ledger
      .filter((entry) => entry.tool === "get_charge")
      .map((entry) => (entry.args as { charge_id?: unknown } | undefined)?.charge_id),
  );
  const referenced = ledger
    .filter((entry) => entry.tool === "get_payment_intent" && entry.status === "ok")
    .map((entry) => entry.fields?.latest_charge)
    .filter((id): id is string => typeof id === "string" && !attempted.has(id));
  return [...new Set(referenced)];
}
