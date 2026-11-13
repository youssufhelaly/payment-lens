import type { Scalar } from "../tools/flatten";
import type { LedgerEntry } from "../tools/registry";
import { NO_EVIDENCE_NEEDED, type Report } from "./report";

export interface CitationCheck {
  ref: string;
  field: string;
  value: string;
  ok: boolean;
  actual?: Scalar;
  reason?: string;
}

export interface Verification {
  checks: CitationCheck[];
  verified: number;
  total: number;
  /** Every citation matches a value a tool actually returned. */
  allVerified: boolean;
  /** The conclusion rests on at least one verified citation (or needs none). */
  supported: boolean;
}

/**
 * Checks each citation against the evidence ledger. This proves citations are real,
 * not that they are sufficient; root-cause correctness is measured by the evals.
 */
export function verifyReport(report: Report, ledger: readonly LedgerEntry[]): Verification {
  const checks = report.evidence.map((citation) => checkCitation(citation, ledger));
  const verified = checks.filter((check) => check.ok).length;
  const okRefs = new Set(ledger.filter((entry) => entry.status === "ok").map((entry) => entry.ref));
  const verifiedData = checks.some((check) => check.ok && okRefs.has(check.ref.trim().toUpperCase()));
  return {
    checks,
    verified,
    total: checks.length,
    allVerified: verified === checks.length,
    supported: NO_EVIDENCE_NEEDED.includes(report.root_cause) || verifiedData,
  };
}

function checkCitation(citation: Report["evidence"][number], ledger: readonly LedgerEntry[]): CitationCheck {
  const ref = citation.ref.trim().toUpperCase();
  const entry = ledger.find((candidate) => candidate.ref === ref);
  if (!entry) return { ...citation, ok: false, reason: `no tool result ${citation.ref}` };
  const field = citation.field.trim();
  // A failed call still returned facts: its status and error, exactly as the model saw them.
  const fields = entry.status === "ok" ? entry.fields : { status: entry.status, error: entry.error ?? null };
  if (!fields) return { ...citation, ok: false, reason: `${ref} returned no data` };
  if (!Object.hasOwn(fields, field)) return { ...citation, ok: false, reason: `${ref} has no field "${field}"` };
  const actual = fields[field] ?? null;
  const ok = normalize(actual) === normalize(citation.value);
  return ok ? { ...citation, ok, actual } : { ...citation, ok, actual, reason: `${ref}.${field} is ${JSON.stringify(actual)}` };
}

function normalize(value: unknown): string {
  return String(value).trim().replace(/^"|"$/g, "").toLowerCase();
}
