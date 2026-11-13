import { mkdir, writeFile } from "node:fs/promises";
import { LlmUnavailableError } from "../agent/llm";
import { createInvestigator, flag } from "../agent/provider";
import { loadDotEnv, readOnlyStripeKey } from "../config";
import { buildCases } from "../evals/cases";
import { scoreCase, summarize, type CaseScore, type Summary } from "../evals/score";
import { loadSeedData } from "../seedData";
import { createStripeReader } from "../stripe/reader";
import { ToolRunner } from "../tools/registry";
import { escapeMarkdownCell, safeText } from "../util/text";

const pct = (passed: number, total: number) => (total === 0 ? "n/a" : `${Math.round((passed / total) * 100)}%`);

/** Model ids become file names, so reduce them to a safe slug. */
const slug = (model: string) => model.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");

function tallyRows(tallies: Summary["byCheck"]): string[] {
  return Object.entries(tallies).map(([name, t]) => `| ${name} | ${t.passed}/${t.total} (${pct(t.passed, t.total)}) |`);
}

function renderMarkdown(model: string, summary: Summary, scores: readonly CaseScore[]): string {
  const medianSeconds = (() => {
    const times = scores.map((s) => s.durationMs).filter((ms) => ms > 0).sort((a, b) => a - b);
    return times.length === 0 ? 0 : (times[Math.floor(times.length / 2)] ?? 0) / 1000;
  })();
  const lines = [
    `# PaymentLens eval report: ${escapeMarkdownCell(model)}`,
    "",
    `Run: ${new Date().toISOString()}  `,
    `Overall: **${summary.passed}/${summary.total} cases passed (${pct(summary.passed, summary.total)})**  `,
    `Median time per investigation: ${medianSeconds.toFixed(1)}s`,
    "",
    "| Check | Passed |",
    "|---|---|",
    ...tallyRows(summary.byCheck),
    "",
    "| Phrasing | Passed |",
    "|---|---|",
    ...tallyRows(summary.byPhrasing),
    "",
    "| Category | Passed |",
    "|---|---|",
    ...tallyRows(summary.byCategory),
    "",
    "| Case | Result | Root cause | Seconds | Failed checks |",
    "|---|---|---|---|---|",
    ...scores.map((score) => {
      const failed = score.checks
        .filter((check) => !check.passed)
        .map((check) => (check.detail ? `${check.name} (${check.detail})` : check.name))
        .join("; ");
      return `| ${escapeMarkdownCell(score.caseId)} | ${score.passed ? "pass" : "FAIL"} | ${score.rootCause ?? "none"} | ${(score.durationMs / 1000).toFixed(1)} | ${escapeMarkdownCell(failed)} |`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  loadDotEnv();
  const argv = process.argv.slice(2);
  const only = flag(argv, "only");
  const provider = flag(argv, "provider");
  const model = flag(argv, "model");

  const cases = buildCases(await loadSeedData()).filter((c) => only === undefined || c.id === only);
  if (cases.length === 0) throw new Error(only ? `No eval case named "${safeText(only)}".` : "No eval cases.");

  const reader = createStripeReader(readOnlyStripeKey());
  const investigator = createInvestigator({ ...(provider ? { provider } : {}), ...(model ? { model } : {}) });
  console.log(`Running ${cases.length} eval case(s) with ${investigator.model}...\n`);

  const scores: CaseScore[] = [];
  const transcripts: unknown[] = [];
  for (const evalCase of cases) {
    const runner = new ToolRunner(reader, { allowedCustomers: evalCase.allowedCustomers });
    try {
      const result = await investigator.investigate(evalCase.question, runner);
      const score = scoreCase(evalCase, result);
      scores.push(score);
      transcripts.push({ case: evalCase, score, result });
      const failed = score.checks.filter((check) => !check.passed).map((check) => check.name);
      console.log(
        `${score.passed ? "PASS" : "FAIL"}  ${evalCase.id.padEnd(36)} ${String(score.rootCause).padEnd(30)} ${(score.durationMs / 1000).toFixed(1)}s${failed.length > 0 ? `  [${failed.join(", ")}]` : ""}`,
      );
    } catch (err) {
      if (err instanceof LlmUnavailableError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      scores.push({
        caseId: evalCase.id,
        category: evalCase.category,
        phrasing: evalCase.phrasing,
        passed: false,
        rootCause: null,
        checks: [{ name: "ran_without_error", passed: false, detail: message }],
        durationMs: 0,
      });
      console.log(`FAIL  ${evalCase.id.padEnd(36)} error: ${safeText(message)}`);
    }
  }

  const summary = summarize(scores);
  console.log(`\n${summary.passed}/${summary.total} cases passed (${pct(summary.passed, summary.total)})`);
  for (const [name, tally] of Object.entries({ ...summary.byCheck, ...summary.byPhrasing })) {
    console.log(`  ${name.padEnd(28)} ${tally.passed}/${tally.total}`);
  }

  if (only === undefined) {
    const name = slug(investigator.model);
    await mkdir("results", { recursive: true });
    await mkdir("data", { recursive: true });
    await writeFile(`results/${name}.md`, renderMarkdown(investigator.model, summary, scores));
    await writeFile(`data/eval-${name}.json`, `${JSON.stringify({ model: investigator.model, runAt: new Date().toISOString(), summary, transcripts }, null, 2)}\n`);
    console.log(`\nWrote results/${name}.md and data/eval-${name}.json.`);
  }
  if (summary.passed < summary.total) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
