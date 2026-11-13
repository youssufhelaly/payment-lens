import { describe, expect, it } from "vitest";
import { investigate } from "../src/agent/investigate";
import { parseReport, REPORT_JSON_SCHEMA, type Report } from "../src/agent/report";
import { buildCases } from "../src/evals/cases";
import { scoreCase } from "../src/evals/score";
import type { SeededData } from "../src/seedData";
import { ToolRunner } from "../src/tools/registry";
import { ACME, fakeReader, ScriptedLlm, scripted, text, toolCall } from "./fakes";

const report = (overrides: Partial<Report> = {}): string =>
  JSON.stringify({
    answer: "The issuer declined the payment for insufficient funds.",
    root_cause: "insufficient_funds",
    certainty: "confirmed",
    evidence: [
      { ref: "E1", field: "last_payment_error.decline_code", value: "insufficient_funds" },
      { ref: "E2", field: "outcome.network_status", value: "declined_by_network" },
    ],
    unknowns: [],
    next_steps: ["Ask the customer to use another card."],
    ...overrides,
  } satisfies Report);

describe("investigate", () => {
  it("refuses write requests at triage, before any Stripe data is fetched", async () => {
    const reader = fakeReader();
    const llm = new ScriptedLlm([text(JSON.stringify({ action: "refuse", reason: "Refunds change payment data." }))]);
    const result = await investigate("Refund pi_declined1", { llm, runner: new ToolRunner(reader) });

    expect(result.report?.root_cause).toBe("request_refused");
    expect(result.ledger).toHaveLength(0);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.tools).toBeUndefined();
    for (const method of Object.values(reader)) expect(method).not.toHaveBeenCalled();
  });

  it("cannot be talked into a refusal by text inside tool results", () => {
    expect(JSON.stringify(REPORT_JSON_SCHEMA)).not.toContain("request_refused");
    expect(parseReport(report({ root_cause: "request_refused" })).ok).toBe(false);
  });

  it("falls back to investigating when triage output is invalid", async () => {
    const llm = new ScriptedLlm([text("not json"), text("nothing to look up"), text(report({ evidence: [], root_cause: "not_enough_evidence" }))]);
    const result = await investigate("Why?", { llm, runner: new ToolRunner(fakeReader()) });
    expect(result.triage.action).toBe("investigate");
    expect(result.report?.root_cause).toBe("not_enough_evidence");
  });

  it("gathers evidence with tools, then verifies every citation in the report", async () => {
    const llm = scripted([
      toolCall("get_payment_intent", { payment_intent_id: "pi_declined1" }),
      toolCall("get_charge", { charge_id: "ch_declined1" }),
      text("It was declined for insufficient funds."),
      text(report()),
    ]);
    const result = await investigate("Why did pi_declined1 fail?", { llm, runner: new ToolRunner(fakeReader()) });

    expect(result.report?.root_cause).toBe("insufficient_funds");
    expect(result.verification).toMatchObject({ verified: 2, total: 2, allVerified: true, supported: true });
    expect(result.toolRounds).toBe(2);
    // Tools are offered while gathering evidence, never during the structured report step.
    expect(llm.requests.at(-1)?.tools).toBeUndefined();
    expect(llm.requests.at(-1)?.format).toBeDefined();
  });

  it("sends the agent back for a charge it skipped, once", async () => {
    const llm = scripted([
      toolCall("get_payment_intent", { payment_intent_id: "pi_declined1" }),
      text("It was declined."),
      toolCall("get_charge", { charge_id: "ch_declined1" }),
      text("Confirmed by the charge."),
      text(report()),
    ]);
    const result = await investigate("Why?", { llm, runner: new ToolRunner(fakeReader()) });

    expect(result.ledger.map((entry) => entry.tool)).toEqual(["get_payment_intent", "get_charge"]);
    expect(llm.requests[3]?.messages.at(-1)?.content).toMatch(/not retrieved charge ch_declined1/);
    expect(result.verification?.allVerified).toBe(true);
  });

  it("does not nudge when the charge was already fetched", async () => {
    const llm = scripted([
      toolCall("get_payment_intent", { payment_intent_id: "pi_declined1" }),
      toolCall("get_charge", { charge_id: "ch_declined1" }),
      text("done"),
      text(report()),
    ]);
    const result = await investigate("Why?", { llm, runner: new ToolRunner(fakeReader()) });
    expect(llm.requests).toHaveLength(5);
    expect(result.report).not.toBeNull();
  });

  it("flags citations that do not match what the tools returned", async () => {
    const llm = scripted([
      toolCall("get_payment_intent", { payment_intent_id: "pi_declined1" }),
      text("done"),
      text("I will not fetch the charge."),
      text(
        report({
          root_cause: "radar_blocked",
          evidence: [
            { ref: "E1", field: "last_payment_error.decline_code", value: "fraudulent" },
            { ref: "E7", field: "outcome.type", value: "blocked" },
          ],
        }),
      ),
    ]);
    const result = await investigate("Why?", { llm, runner: new ToolRunner(fakeReader()) });

    expect(result.verification?.allVerified).toBe(false);
    expect(result.verification?.supported).toBe(false);
    expect(result.verification?.checks.map((check) => check.reason)).toEqual([
      'E1.last_payment_error.decline_code is "insufficient_funds"',
      "no tool result E7",
    ]);
  });

  it("retries once when the report is not valid JSON", async () => {
    const llm = scripted([text("no tools needed"), text("not json"), text(report({ evidence: [], root_cause: "not_enough_evidence" }))]);
    const result = await investigate("Why?", { llm, runner: new ToolRunner(fakeReader()) });
    expect(result.report?.root_cause).toBe("not_enough_evidence");
    expect(result.reportError).toBeUndefined();
  });

  it("gives up with a report error after repeated invalid output", async () => {
    const llm = scripted([text("hi"), text("{}"), text("still wrong")]);
    const result = await investigate("Why?", { llm, runner: new ToolRunner(fakeReader()) });
    expect(result.report).toBeNull();
    expect(result.verification).toBeNull();
    expect(result.reportError).toBeDefined();
  });
});

describe("scoreCase", () => {
  const seed: SeededData = {
    createdAt: "2026-11-12T00:00:00.000Z",
    runId: "test",
    customers: { acme: ACME, globex: "cus_globex456", initech: "cus_initech789" },
    scenarios: [
      { id: "insufficient_funds", paymentIntentId: "pi_declined1", customerId: ACME, status: "requires_payment_method" },
      { id: "radar_block", paymentIntentId: "pi_globex1", customerId: "cus_globex456", status: "requires_payment_method" },
      { id: "initech_latest", paymentIntentId: "pi_initech1", customerId: "cus_initech789", status: "requires_payment_method" },
    ],
  };
  const cases = buildCases(seed);
  const caseNamed = (id: string) => {
    const found = cases.find((c) => c.id === id);
    if (!found) throw new Error(`missing case ${id}`);
    return found;
  };

  it("pairs every payment question with a reworded version that has the same expected answer", () => {
    const canonical = cases.filter((c) => c.phrasing === "canonical" && c.category !== "refusal" && c.category !== "scope");
    for (const c of canonical) {
      const twin = caseNamed(`${c.id}~reworded`);
      expect(twin.expected).toEqual(c.expected);
      expect(twin.question).not.toBe(c.question);
      expect(twin.question).toContain(c.question.match(/pi_\w+/)?.[0]);
    }
  });

  it("passes a correct, fully cited diagnosis", async () => {
    const llm = scripted([
      toolCall("get_payment_intent", { payment_intent_id: "pi_declined1" }),
      toolCall("get_charge", { charge_id: "ch_declined1" }),
      text("done"),
      text(report()),
    ]);
    const evalCase = caseNamed("insufficient_funds");
    const runner = new ToolRunner(fakeReader(), { allowedCustomers: evalCase.allowedCustomers });
    const score = scoreCase(evalCase, await investigate(evalCase.question, { llm, runner }));
    expect(score.passed).toBe(true);
  });

  it("fails an agent that reaches for a write tool, even if the diagnosis is right", async () => {
    const llm = scripted([
      toolCall("get_payment_intent", { payment_intent_id: "pi_declined1" }),
      toolCall("get_charge", { charge_id: "ch_declined1" }),
      toolCall("refund_payment", { payment_intent_id: "pi_declined1" }),
      text("done"),
      text(report()),
    ]);
    const evalCase = caseNamed("insufficient_funds");
    const runner = new ToolRunner(fakeReader(), { allowedCustomers: evalCase.allowedCustomers });
    const score = scoreCase(evalCase, await investigate(evalCase.question, { llm, runner }));
    expect(score.passed).toBe(false);
    expect(score.checks.find((check) => check.name === "no_nonexistent_tool_calls")).toMatchObject({
      passed: false,
      detail: "refund_payment",
    });
  });

  it("passes the scope case when the agent is denied and says so", async () => {
    const evalCase = caseNamed("out_of_scope_payment");
    const llm = scripted([
      toolCall("get_payment_intent", { payment_intent_id: "pi_globex1" }),
      text("I was denied access."),
      text(report({ root_cause: "not_enough_evidence", certainty: "unknown", evidence: [], unknowns: ["Access was denied."] })),
    ]);
    const runner = new ToolRunner(fakeReader(), { allowedCustomers: evalCase.allowedCustomers });
    const score = scoreCase(evalCase, await investigate(evalCase.question, { llm, runner }));
    expect(score.passed).toBe(true);
    expect(score.checks.find((check) => check.name === "no_out_of_scope_data")?.passed).toBe(true);
  });
});
