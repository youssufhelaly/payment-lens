import { z } from "zod";
import type { ToolSpec } from "../agent/llm";
import type { StripeReader } from "../stripe/reader";
import { flatten, type Scalar } from "./flatten";
import {
  projectCharge,
  projectCustomer,
  projectPaymentIntent,
  projectPaymentMethod,
  projectPaymentSummary,
} from "./projections";

export const ID_PATTERNS = {
  paymentIntent: /^pi_[A-Za-z0-9]{1,64}$/,
  charge: /^(ch|py)_[A-Za-z0-9]{1,64}$/,
  customer: /^cus_[A-Za-z0-9]{1,64}$/,
  paymentMethod: /^pm_[A-Za-z0-9]{1,64}$/,
} as const;

export type ToolStatus = "ok" | "denied" | "blocked" | "invalid_args" | "error";

/** One row of the evidence ledger. `ref` (E1, E2, ...) is what the model cites. */
export interface LedgerEntry {
  ref: string;
  tool: string;
  args: unknown;
  status: ToolStatus;
  owner?: string | null;
  data?: object;
  fields?: Record<string, Scalar>;
  error?: string;
}

type AccessCheck = (owner: string | null) => boolean;
type ToolOutcome = { status: "ok"; owner: string | null; data: object } | { status: "denied"; reason: string };

interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(rawArgs: unknown, reader: StripeReader, canAccess: AccessCheck): Promise<ToolOutcome>;
}

const DENIED = "Access denied: this object belongs to a customer outside your investigation scope.";

function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  params: S;
  /** Lets list tools reject out-of-scope requests before any API call is made. */
  ownerFromArgs?: (args: z.infer<S>) => string;
  run: (args: z.infer<S>, reader: StripeReader) => Promise<{ owner: string | null; data: object }>;
}): Tool {
  const parameters = { ...(z.toJSONSchema(def.params) as Record<string, unknown>) };
  delete parameters.$schema;
  return {
    name: def.name,
    description: def.description,
    parameters,
    async execute(rawArgs, reader, canAccess) {
      const args = def.params.parse(rawArgs ?? {});
      if (def.ownerFromArgs && !canAccess(def.ownerFromArgs(args))) return { status: "denied", reason: DENIED };
      const result = await def.run(args, reader);
      // Ownership is checked after the fetch and before anything reaches the model.
      if (!canAccess(result.owner)) return { status: "denied", reason: DENIED };
      return { status: "ok", ...result };
    },
  };
}

export const TOOLS: readonly Tool[] = [
  defineTool({
    name: "get_payment_intent",
    description:
      "Retrieve a PaymentIntent (pi_...). Returns status, last_payment_error (code, decline_code), latest_charge id, and next_action_type when the customer still has to act, such as 3D Secure.",
    params: z.object({
      payment_intent_id: z.string().regex(ID_PATTERNS.paymentIntent).describe("PaymentIntent id, starts with pi_"),
    }),
    run: async ({ payment_intent_id }, reader) => {
      const data = projectPaymentIntent(await reader.retrievePaymentIntent(payment_intent_id));
      return { owner: data.customer, data };
    },
  }),
  defineTool({
    name: "get_charge",
    description:
      "Retrieve a charge (ch_...). Returns the outcome: network_status (whether the card network saw it), type (blocked means Stripe Radar blocked it), reason, risk_level, failure_code, and card checks.",
    params: z.object({
      charge_id: z.string().regex(ID_PATTERNS.charge).describe("Charge id, starts with ch_"),
    }),
    run: async ({ charge_id }, reader) => {
      const data = projectCharge(await reader.retrieveCharge(charge_id));
      return { owner: data.customer, data };
    },
  }),
  defineTool({
    name: "get_customer",
    description: "Retrieve a customer (cus_...). Returns creation date, masked email, and delinquency status.",
    params: z.object({
      customer_id: z.string().regex(ID_PATTERNS.customer).describe("Customer id, starts with cus_"),
    }),
    run: async ({ customer_id }, reader) => {
      const data = projectCustomer(await reader.retrieveCustomer(customer_id));
      return { owner: data.id, data };
    },
  }),
  defineTool({
    name: "get_payment_method",
    description: "Retrieve a payment method (pm_...). Returns card brand, last 4 digits, expiry, funding type, and CVC check.",
    params: z.object({
      payment_method_id: z.string().regex(ID_PATTERNS.paymentMethod).describe("PaymentMethod id, starts with pm_"),
    }),
    run: async ({ payment_method_id }, reader) => {
      const data = projectPaymentMethod(await reader.retrievePaymentMethod(payment_method_id));
      return { owner: data.customer, data };
    },
  }),
  defineTool({
    name: "list_customer_payments",
    description: "List a customer's most recent PaymentIntents, newest first, with status and decline codes.",
    params: z.object({
      customer_id: z.string().regex(ID_PATTERNS.customer).describe("Customer id, starts with cus_"),
      limit: z.number().int().min(1).max(10).default(5).describe("How many payments to return (1-10)"),
    }),
    ownerFromArgs: ({ customer_id }) => customer_id,
    run: async ({ customer_id, limit }, reader) => {
      const payments = await reader.listPaymentIntents(customer_id, limit);
      return { owner: customer_id, data: { customer: customer_id, payments: payments.map(projectPaymentSummary) } };
    },
  }),
];

export interface ToolRunnerOptions {
  /** Customers this session may investigate. Omit for unrestricted (single-tenant) use. */
  allowedCustomers?: Iterable<string>;
}

export class ToolRunner {
  readonly ledger: LedgerEntry[] = [];
  private readonly scope: ReadonlySet<string> | null;
  private refCount = 0;

  constructor(
    private readonly reader: StripeReader,
    options: ToolRunnerOptions = {},
  ) {
    this.scope = options.allowedCustomers ? new Set(options.allowedCustomers) : null;
  }

  specs(): ToolSpec[] {
    return TOOLS.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }

  async call(name: string, args: unknown): Promise<LedgerEntry> {
    // Reserved before the await: some providers run tool calls concurrently.
    const ref = `E${++this.refCount}`;
    const entry = await this.execute(ref, name, args);
    this.ledger.push(entry);
    return entry;
  }

  private canAccess = (owner: string | null): boolean =>
    this.scope === null || (owner !== null && this.scope.has(owner));

  private async execute(ref: string, name: string, args: unknown): Promise<LedgerEntry> {
    const base = { ref, tool: name, args };
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (!tool) {
      return {
        ...base,
        status: "blocked",
        error: `Tool "${name}" does not exist. This investigator is read-only; available tools: ${TOOLS.map((t) => t.name).join(", ")}.`,
      };
    }
    try {
      const outcome = await tool.execute(args, this.reader, this.canAccess);
      if (outcome.status === "denied") return { ...base, status: "denied", error: outcome.reason };
      return { ...base, status: "ok", owner: outcome.owner, data: outcome.data, fields: flatten(outcome.data) };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return { ...base, status: "invalid_args", error: `Invalid arguments: ${z.prettifyError(err)}` };
      }
      return { ...base, status: "error", error: describeError(err) };
    }
  }
}

/** What the model sees for a tool result: flat field names it can cite verbatim. */
export function renderForModel(entry: LedgerEntry): string {
  if (entry.status === "ok") return JSON.stringify({ ref: entry.ref, status: "ok", fields: entry.fields });
  return JSON.stringify({ ref: entry.ref, status: entry.status, error: entry.error });
}

const KEY_PATTERN = /\b(sk|rk|pk)_(test|live)_[A-Za-z0-9*]+/g;

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(KEY_PATTERN, "[redacted key]").slice(0, 300);
}
