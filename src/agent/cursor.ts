import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, CursorAgentError, type SDKAgent, type SDKCustomTool, type SDKJsonValue } from "@cursor/sdk";
import { renderForModel, type ToolRunner } from "../tools/registry";
import { refusalResult, TRIAGE_FALLBACK, unfetchedCharges, type InvestigationEvent, type InvestigationResult } from "./investigate";
import { LlmUnavailableError } from "./llm";
import { CURSOR_REPORT_INSTRUCTIONS, CURSOR_TOOLS_NOTE, CURSOR_TRIAGE_INSTRUCTIONS, SYSTEM_PROMPT } from "./prompts";
import { REPORT_JSON_SCHEMA, TRIAGE_JSON_SCHEMA, validateReport, validateTriage, type Report, type Triage } from "./report";
import { verifyReport } from "./verify";

export interface CursorConfig {
  apiKey: string;
  model: string;
}

/**
 * Investigates with a Cursor SDK agent. `tools: ["mcp"]` removes every built-in tool
 * (shell, file read and edit, web), so the agent can only reach the in-process tools
 * registered here, which run through the same ToolRunner allowlist and customer scope
 * as the Ollama path. The agent works in an empty temporary directory.
 */
export async function investigateWithCursor(
  question: string,
  config: CursorConfig,
  runner: ToolRunner,
  onEvent?: (event: InvestigationEvent) => void,
): Promise<InvestigationResult> {
  const started = Date.now();
  const model = `cursor/${config.model}`;
  const workspace = await mkdtemp(join(tmpdir(), "payment-lens-"));
  try {
    const triage = await cursorTriage(question, config, workspace);
    if (triage.action === "refuse") return refusalResult(question, model, triage, runner, started);

    const submitted: { report: Report | null; error?: string } = { report: null };
    const agent = await startAgent(config, workspace, {
      ...stripeTools(runner, onEvent),
      submit_report: {
        description: "Submit your final report. If it is rejected, fix the listed problems and submit again.",
        inputSchema: REPORT_JSON_SCHEMA as Record<string, SDKJsonValue>,
        execute: (args) => {
          const parsed = validateReport(args);
          if (parsed.ok) {
            submitted.report = parsed.value;
            return "Report accepted.";
          }
          submitted.error = parsed.error;
          onEvent?.({ type: "report_retry", error: parsed.error });
          return { content: [{ type: "text", text: `Report rejected: ${parsed.error}` }], isError: true };
        },
      },
    });

    let sends = 0;
    try {
      await sendAndWait(agent, `${SYSTEM_PROMPT}\n\n${CURSOR_TOOLS_NOTE}\n\n${CURSOR_REPORT_INSTRUCTIONS}\n\nQuestion: ${question}`, runner);
      sends++;
      const skipped = unfetchedCharges(runner.ledger);
      if (skipped.length > 0) {
        const message = `Before concluding: you have not retrieved charge ${skipped.join(", ")}. The charge outcome shows whether Stripe Radar blocked the payment or the card issuer declined it. Retrieve it, then call submit_report again.`;
        onEvent?.({ type: "nudge", message });
        submitted.report = null;
        await sendAndWait(agent, message, runner);
        sends++;
      }
      if (submitted.report === null) {
        await sendAndWait(agent, "You have not submitted a valid report. Call submit_report now.", runner);
        sends++;
      }
    } finally {
      await agent[Symbol.asyncDispose]();
    }

    const report = submitted.report as Report | null;
    return {
      question,
      model,
      triage,
      report,
      ...(report ? {} : { reportError: submitted.error ?? "The agent never submitted a report." }),
      verification: report ? verifyReport(report, runner.ledger) : null,
      ledger: runner.ledger,
      toolRounds: sends,
      durationMs: Date.now() - started,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function cursorTriage(question: string, config: CursorConfig, workspace: string): Promise<Triage> {
  const decision: { value: Triage | null } = { value: null };
  const agent = await startAgent(config, workspace, {
    submit_triage: {
      description: "Submit whether to investigate or refuse the request.",
      inputSchema: TRIAGE_JSON_SCHEMA as Record<string, SDKJsonValue>,
      execute: (args) => {
        const parsed = validateTriage(args);
        if (!parsed.ok) return { content: [{ type: "text", text: `Rejected: ${parsed.error}` }], isError: true };
        decision.value = parsed.value;
        return "Decision recorded.";
      },
    },
  });
  try {
    await sendAndWait(agent, `${CURSOR_TRIAGE_INSTRUCTIONS}\n\nRequest: ${question}`);
  } finally {
    await agent[Symbol.asyncDispose]();
  }
  return decision.value ?? TRIAGE_FALLBACK;
}

function stripeTools(runner: ToolRunner, onEvent?: (event: InvestigationEvent) => void): Record<string, SDKCustomTool> {
  const tools: Record<string, SDKCustomTool> = {};
  for (const spec of runner.specs()) {
    const { name, description, parameters } = spec.function;
    tools[name] = {
      description,
      inputSchema: parameters as Record<string, SDKJsonValue>,
      annotations: { readOnlyHint: true },
      execute: async (args) => {
        const entry = await runner.call(name, args);
        onEvent?.({ type: "tool", entry });
        return renderForModel(entry);
      },
    };
  }
  return tools;
}

async function startAgent(config: CursorConfig, workspace: string, customTools: Record<string, SDKCustomTool>): Promise<SDKAgent> {
  try {
    return await Agent.create({
      apiKey: config.apiKey,
      model: { id: config.model },
      tools: ["mcp"],
      local: { cwd: workspace, settingSources: [], customTools },
    });
  } catch (err) {
    if (err instanceof CursorAgentError) {
      throw new LlmUnavailableError(`Cursor agent could not start: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Built-in tools are disabled, so any tool call that is not MCP is unexpected. It is
 * recorded as a blocked call so the evals flag it.
 */
async function sendAndWait(agent: SDKAgent, prompt: string, runner?: ToolRunner): Promise<void> {
  let run;
  try {
    run = await agent.send(prompt);
  } catch (err) {
    if (err instanceof CursorAgentError) {
      throw new LlmUnavailableError(`Cursor run could not start: ${err.message}`, { cause: err });
    }
    throw err;
  }
  const seen = new Set<string>();
  for await (const event of run.stream()) {
    if (event.type !== "tool_call" || seen.has(event.call_id)) continue;
    seen.add(event.call_id);
    if (runner && !/mcp/i.test(event.name)) await runner.call(`builtin:${event.name}`, {});
  }
  const result = await run.wait();
  if (result.status === "error") {
    throw new Error(`Cursor run ${result.id} failed: ${result.error?.message ?? "unknown error"}`);
  }
}
