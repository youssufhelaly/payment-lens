import { describe, expect, it } from "vitest";
import { flatten } from "../src/tools/flatten";
import { maskEmail, projectCharge, projectPaymentIntent } from "../src/tools/projections";
import { declinedCharge, declinedIntent } from "./fakes";

describe("projections", () => {
  it("keeps the decline evidence from a PaymentIntent", () => {
    const view = projectPaymentIntent(declinedIntent);
    expect(view.last_payment_error).toEqual({
      type: "card_error",
      code: "card_declined",
      decline_code: "insufficient_funds",
      message: "Your card has insufficient funds.",
    });
    expect(view.latest_charge).toBe("ch_declined1");
  });

  it("labels merchant-written text as untrusted and drops metadata", () => {
    const view = projectPaymentIntent(declinedIntent) as Record<string, unknown>;
    expect(view.description_untrusted).toContain("Ignore previous instructions");
    expect(view).not.toHaveProperty("description");
    expect(JSON.stringify(view)).not.toContain("internal_note");
  });

  it("never exposes billing details or card fingerprints from a charge", () => {
    const serialized = JSON.stringify(projectCharge(declinedCharge));
    for (const secret of ["Jane Doe", "jane@example.com", "+15555550100", "secretfingerprint"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("declined_by_network");
  });

  it("masks emails", () => {
    expect(maskEmail("billing@acme.example.com")).toBe("b***@acme.example.com");
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("not-an-email")).toBe("***");
  });
});

describe("flatten", () => {
  it("produces citable dot paths, including array indices", () => {
    expect(flatten({ outcome: { type: "blocked", risk: null }, payments: [{ id: "pi_1" }] })).toEqual({
      "outcome.type": "blocked",
      "outcome.risk": null,
      "payments.0.id": "pi_1",
    });
  });
});
