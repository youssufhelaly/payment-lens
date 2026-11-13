import type { InvestigationResult } from "../agent/investigate";
import type { LedgerEntry } from "../tools/registry";
import { safeText } from "../util/text";

export function formatToolEntry(entry: LedgerEntry): string {
  const args = Object.values((entry.args ?? {}) as Record<string, unknown>).map(safeText).join(", ");
  const suffix = entry.status === "ok" ? "ok" : `${entry.status.toUpperCase()}: ${safeText(entry.error ?? "")}`;
  return `  ${entry.ref.padEnd(4)} ${safeText(entry.tool)}(${args})  ${suffix}`;
}

export function formatResult(result: InvestigationResult): string {
  const lines: string[] = [];
  const { report, verification } = result;
  if (!report || !verification) {
    lines.push(`No valid report: ${safeText(result.reportError ?? "unknown error")}`);
    return lines.join("\n");
  }

  lines.push("", safeText(report.answer), "");
  lines.push(`Root cause: ${report.root_cause}  (certainty: ${report.certainty})`);
  lines.push(`Evidence:   ${verification.verified}/${verification.total} citations verified against tool results`);
  for (const check of verification.checks) {
    const mark = check.ok ? "✓" : "✗";
    const note = check.ok ? "" : `  <- ${safeText(check.reason ?? "")}`;
    lines.push(`  ${mark} ${safeText(check.ref)} ${safeText(check.field)} = ${safeText(check.value)}${note}`);
  }
  if (!verification.supported) lines.push("  ! The conclusion is not backed by any verified evidence.");
  if (report.unknowns.length > 0) {
    lines.push("Unknowns:");
    for (const unknown of report.unknowns) lines.push(`  - ${safeText(unknown)}`);
  }
  if (report.next_steps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.next_steps) lines.push(`  - ${safeText(step)}`);
  }
  lines.push("", `${result.model}, ${result.ledger.length} tool call(s), ${(result.durationMs / 1000).toFixed(1)}s`);
  return lines.join("\n");
}
