import { cursorConfig, llmProvider, modelId, ollamaConfig } from "../config";
import type { ToolRunner } from "../tools/registry";
import { investigateWithCursor } from "./cursor";
import { investigate, type InvestigationEvent, type InvestigationResult } from "./investigate";
import { OllamaClient } from "./llm";

export interface Investigator {
  readonly model: string;
  investigate(question: string, runner: ToolRunner, onEvent?: (event: InvestigationEvent) => void): Promise<InvestigationResult>;
}

export function createInvestigator(options: { provider?: string; model?: string } = {}): Investigator {
  if (llmProvider(process.env, options.provider) === "cursor") {
    const config = cursorConfig(process.env, options.model);
    return {
      model: `cursor/${config.model}`,
      investigate: (question, runner, onEvent) => investigateWithCursor(question, config, runner, onEvent),
    };
  }
  const base = ollamaConfig();
  const llm = new OllamaClient({ ...base, model: options.model ? modelId(options.model) : base.model });
  return {
    model: llm.model,
    investigate: (question, runner, onEvent) => investigate(question, { llm, runner, ...(onEvent ? { onEvent } : {}) }),
  };
}

/** Reads `--name value` from argv. */
export function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}
