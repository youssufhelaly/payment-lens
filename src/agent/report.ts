import { z } from "zod";

export const ROOT_CAUSES = [
  "insufficient_funds",
  "expired_card",
  "incorrect_cvc",
  "lost_or_stolen_card",
  "issuer_suspected_fraud",
  "radar_blocked",
  "authentication_not_completed",
  "processing_error",
  "velocity_limit",
  "issuer_declined_unspecified",
  "payment_succeeded",
  "not_enough_evidence",
  "request_refused",
] as const;

export type RootCause = (typeof ROOT_CAUSES)[number];

/** Root causes that legitimately need no supporting evidence. */
export const NO_EVIDENCE_NEEDED: readonly RootCause[] = ["request_refused", "not_enough_evidence"];

// Field order is generation order under constrained decoding: the model writes out the
// evidence before it commits to a label, and the label before the prose answer.
export const ReportSchema = z.object({
  evidence: z
    .array(
      z.object({
        ref: z.string().describe("Tool result reference, for example E2"),
        field: z.string().describe("Exact field name from that tool result"),
        value: z.string().describe("Exact value of that field"),
      }),
    )
    .max(12),
  unknowns: z.array(z.string()).max(8),
  root_cause: z.enum(ROOT_CAUSES),
  certainty: z.enum(["confirmed", "inferred", "unknown"]),
  answer: z.string().min(1).describe("2-4 plain-English sentences for a support engineer."),
  next_steps: z.array(z.string()).max(5),
});

export type Report = z.infer<typeof ReportSchema>;

/**
 * Refusals are decided by triage, before any tool data is in context. The investigation
 * report cannot express one, so instructions injected into Stripe data cannot trigger it.
 */
const InvestigationReportSchema = ReportSchema.extend({
  root_cause: z.enum(ROOT_CAUSES.filter((cause) => cause !== "request_refused")),
});

export const TriageSchema = z.object({
  action: z.enum(["investigate", "refuse"]),
  reason: z.string().describe("One sentence explaining the decision."),
});

export type Triage = z.infer<typeof TriageSchema>;

function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const json = { ...(z.toJSONSchema(schema) as Record<string, unknown>) };
  delete json.$schema;
  return json;
}

export const REPORT_JSON_SCHEMA = jsonSchemaFor(InvestigationReportSchema);
export const TRIAGE_JSON_SCHEMA = jsonSchemaFor(TriageSchema);

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function validateWith<T>(schema: z.ZodType<T>, value: unknown): Parsed<T> {
  const result = schema.safeParse(value);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: z.prettifyError(result.error) };
}

function parseWith<T>(schema: z.ZodType<T>, text: string): Parsed<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "the reply was not valid JSON" };
  }
  return validateWith(schema, json);
}

export const parseReport = (text: string): Parsed<Report> => parseWith(InvestigationReportSchema, text);
export const parseTriage = (text: string): Parsed<Triage> => parseWith(TriageSchema, text);
export const validateReport = (value: unknown): Parsed<Report> => validateWith(InvestigationReportSchema, value);
export const validateTriage = (value: unknown): Parsed<Triage> => validateWith(TriageSchema, value);
