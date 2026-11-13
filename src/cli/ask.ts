import { createInvestigator } from "../agent/provider";
import { loadDotEnv, readOnlyStripeKey } from "../config";
import { createStripeReader } from "../stripe/reader";
import { ID_PATTERNS, ToolRunner } from "../tools/registry";
import { formatResult, formatToolEntry } from "./format";

const USAGE = `Usage: npm run ask -- "<question>" [--customer cus_...] [--provider ollama|cursor] [--model id] [--json]

  --customer  Restrict the investigation to this customer (repeatable).
  --provider  Override LLM_PROVIDER from .env.
  --model     Override the model for the chosen provider.
  --json      Print the full result, including the evidence ledger, as JSON.`;

const MAX_QUESTION_LENGTH = 1000;

interface Args {
  question: string;
  customers: string[];
  json: boolean;
  provider?: string;
  model?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { question: "", customers: [], json: false };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--customer") {
      const value = argv[++i];
      if (!value || !ID_PATTERNS.customer.test(value)) throw new Error("--customer expects a customer id like cus_123");
      args.customers.push(value);
    } else if (arg === "--provider" || arg === "--model") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} expects a value`);
      args[arg === "--provider" ? "provider" : "model"] = value;
    } else if (arg === "--json") {
      args.json = true;
    } else {
      words.push(arg);
    }
  }
  args.question = words.join(" ").trim();
  if (args.question === "") throw new Error(USAGE);
  if (args.question.length > MAX_QUESTION_LENGTH) throw new Error(`Question is longer than ${MAX_QUESTION_LENGTH} characters.`);
  return args;
}

async function main(): Promise<void> {
  loadDotEnv();
  const { question, customers, json, provider, model } = parseArgs(process.argv.slice(2));
  const runner = new ToolRunner(createStripeReader(readOnlyStripeKey()), {
    ...(customers.length > 0 ? { allowedCustomers: customers } : {}),
  });
  const investigator = createInvestigator({ ...(provider ? { provider } : {}), ...(model ? { model } : {}) });

  if (!json) console.log(`Investigating with ${investigator.model}...`);
  const result = await investigator.investigate(question, runner, (event) => {
    if (json) return;
    if (event.type === "tool") console.log(formatToolEntry(event.entry));
    else if (event.type === "nudge") console.log("  (completeness check: asking the agent to fetch the skipped charge)");
    else console.log(`  (report was invalid, retrying: ${event.error.split("\n")[0]})`);
  });

  console.log(json ? JSON.stringify(result, null, 2) : formatResult(result));
  if (!result.report) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
