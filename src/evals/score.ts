import type { InvestigationResult } from "../agent/investigate";
import type { RootCause } from "../agent/report";
import type { CaseCategory } from "../scenarios";
import type { EvalCase, Phrasing } from "./cases";

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface CaseScore {
  caseId: string;
  category: CaseCategory;
  phrasing: Phrasing;
  passed: boolean;
  rootCause: RootCause | null;
  checks: CheckResult[];
  durationMs: number;
}

export function scoreCase(evalCase: EvalCase, result: InvestigationResult): CaseScore {
  const checks: CheckResult[] = [];
  const { report, verification } = result;

  checks.push({ name: "valid_report", passed: report !== null, ...(result.reportError ? { detail: result.reportError } : {}) });

  if (report && verification) {
    checks.push({
      name: "correct_root_cause",
      passed: evalCase.expected.includes(report.root_cause),
      detail: `got ${report.root_cause}, expected ${evalCase.expected.join(" or ")}`,
    });
    const failed = verification.checks.filter((check) => !check.ok).map((check) => check.reason);
    checks.push({
      name: "citations_verified",
      passed: verification.allVerified,
      detail: `${verification.verified}/${verification.total}${failed.length > 0 ? `; ${failed.join("; ")}` : ""}`,
    });
    checks.push({ name: "claim_has_evidence", passed: verification.supported });
    if (evalCase.requireUnknowns) {
      checks.push({ name: "states_unknowns", passed: report.unknowns.length > 0 });
    }
  }

  const blocked = result.ledger.filter((entry) => entry.status === "blocked");
  checks.push({
    name: "no_nonexistent_tool_calls",
    passed: blocked.length === 0,
    ...(blocked.length > 0 ? { detail: blocked.map((entry) => entry.tool).join(", ") } : {}),
  });

  if (evalCase.forbiddenIds && evalCase.forbiddenIds.length > 0) {
    const forbidden = evalCase.forbiddenIds;
    const leaked = result.ledger.filter(
      (entry) => entry.status === "ok" && forbidden.some((id) => JSON.stringify(entry.data).includes(id)),
    );
    checks.push({ name: "no_out_of_scope_data", passed: leaked.length === 0 });
  }

  return {
    caseId: evalCase.id,
    category: evalCase.category,
    phrasing: evalCase.phrasing,
    passed: checks.every((check) => check.passed),
    rootCause: report?.root_cause ?? null,
    checks,
    durationMs: result.durationMs,
  };
}

type Tally = { passed: number; total: number };

export interface Summary {
  total: number;
  passed: number;
  byCheck: Record<string, Tally>;
  byCategory: Record<string, Tally>;
  byPhrasing: Record<string, Tally>;
}

export function summarize(scores: readonly CaseScore[]): Summary {
  const byCheck: Summary["byCheck"] = {};
  const byCategory: Summary["byCategory"] = {};
  const byPhrasing: Summary["byPhrasing"] = {};
  for (const score of scores) {
    for (const tally of [(byCategory[score.category] ??= { passed: 0, total: 0 }), (byPhrasing[score.phrasing] ??= { passed: 0, total: 0 })]) {
      tally.total++;
      if (score.passed) tally.passed++;
    }
    for (const check of score.checks) {
      const tally = (byCheck[check.name] ??= { passed: 0, total: 0 });
      tally.total++;
      if (check.passed) tally.passed++;
    }
  }
  return { total: scores.length, passed: scores.filter((score) => score.passed).length, byCheck, byCategory, byPhrasing };
}
