import { describe, expect, it } from "vitest";
import { verifyReport } from "../src/agent/verify";
import { renderForModel, ToolRunner } from "../src/tools/registry";
import { ACME, fakeReader, GLOBEX } from "./fakes";

describe("ToolRunner", () => {
  it("returns projected, flattened fields with sequential evidence refs", async () => {
    const runner = new ToolRunner(fakeReader());
    const first = await runner.call("get_payment_intent", { payment_intent_id: "pi_declined1" });
    const second = await runner.call("get_charge", { charge_id: "ch_declined1" });
    expect(first).toMatchObject({ ref: "E1", status: "ok" });
    expect(first.fields?.["last_payment_error.decline_code"]).toBe("insufficient_funds");
    expect(second.fields?.["outcome.network_status"]).toBe("declined_by_network");
  });

  it("gives concurrent calls distinct evidence refs", async () => {
    const runner = new ToolRunner(fakeReader());
    const entries = await Promise.all([
      runner.call("get_payment_intent", { payment_intent_id: "pi_declined1" }),
      runner.call("get_charge", { charge_id: "ch_declined1" }),
      runner.call("get_payment_intent", { payment_intent_id: "pi_declined1" }),
    ]);
    expect(entries.map((entry) => entry.ref)).toEqual(["E1", "E2", "E3"]);
  });

  it("lets a failed call be cited only for its status and error", async () => {
    const runner = new ToolRunner(fakeReader(), { allowedCustomers: [ACME] });
    await runner.call("get_payment_intent", { payment_intent_id: "pi_globex1" });
    const report = {
      evidence: [
        { ref: "E1", field: "status", value: "denied" },
        { ref: "E1", field: "outcome.type", value: "blocked" },
      ],
      unknowns: [],
      root_cause: "radar_blocked" as const,
      certainty: "confirmed" as const,
      answer: "Blocked.",
      next_steps: [],
    };
    const verification = verifyReport(report, runner.ledger);
    expect(verification.checks.map((check) => check.ok)).toEqual([true, false]);
    expect(verification.supported).toBe(false);
  });

  it("blocks tools that do not exist without touching Stripe", async () => {
    const reader = fakeReader();
    const runner = new ToolRunner(reader);
    const entry = await runner.call("refund_payment", { payment_intent_id: "pi_declined1" });
    expect(entry.status).toBe("blocked");
    expect(entry.error).toMatch(/read-only/);
    for (const method of Object.values(reader)) expect(method).not.toHaveBeenCalled();
  });

  it("rejects malformed ids before calling Stripe", async () => {
    const reader = fakeReader();
    const runner = new ToolRunner(reader);
    const entry = await runner.call("get_payment_intent", { payment_intent_id: "../../etc/passwd" });
    expect(entry.status).toBe("invalid_args");
    expect(reader.retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it("denies objects owned by customers outside the scope and returns no data", async () => {
    const runner = new ToolRunner(fakeReader(), { allowedCustomers: [ACME] });
    const entry = await runner.call("get_payment_intent", { payment_intent_id: "pi_globex1" });
    expect(entry.status).toBe("denied");
    expect(entry.fields).toBeUndefined();
    expect(renderForModel(entry)).not.toContain("pi_globex1");
  });

  it("denies out-of-scope list requests before any API call", async () => {
    const reader = fakeReader();
    const runner = new ToolRunner(reader, { allowedCustomers: [ACME] });
    const entry = await runner.call("list_customer_payments", { customer_id: GLOBEX });
    expect(entry.status).toBe("denied");
    expect(reader.listPaymentIntents).not.toHaveBeenCalled();
  });

  it("redacts API keys from error messages", async () => {
    const reader = fakeReader();
    reader.retrieveCharge.mockRejectedValueOnce(new Error("The provided key 'rk_test_51Abc***xyz' lacks permission"));
    const entry = await new ToolRunner(reader).call("get_charge", { charge_id: "ch_x1" });
    expect(entry.status).toBe("error");
    expect(entry.error).not.toContain("rk_test_");
  });
});
