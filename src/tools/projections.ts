import type Stripe from "stripe";

/*
 * Every tool returns an explicit allowlist of fields, never the raw API object.
 * Names, addresses, phone numbers, billing details, and card fingerprints are never
 * projected. Free text written by merchants or customers is suffixed `_untrusted`.
 */

type Expandable = string | { id: string } | null | undefined;

function idOf(value: Expandable): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : value.id;
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

export function projectPaymentIntent(pi: Stripe.PaymentIntent) {
  const error = pi.last_payment_error;
  return {
    id: pi.id,
    object: "payment_intent" as const,
    status: pi.status,
    amount: pi.amount,
    currency: pi.currency,
    created: iso(pi.created),
    customer: idOf(pi.customer),
    payment_method: idOf(pi.payment_method),
    latest_charge: idOf(pi.latest_charge),
    next_action_type: pi.next_action?.type ?? null,
    cancellation_reason: pi.cancellation_reason ?? null,
    last_payment_error: error
      ? {
          type: error.type,
          code: error.code ?? null,
          decline_code: error.decline_code ?? null,
          message: error.message ?? null,
        }
      : null,
    description_untrusted: pi.description ?? null,
  };
}

export function projectPaymentSummary(pi: Stripe.PaymentIntent) {
  return {
    id: pi.id,
    status: pi.status,
    amount: pi.amount,
    currency: pi.currency,
    created: iso(pi.created),
    error_code: pi.last_payment_error?.code ?? null,
    decline_code: pi.last_payment_error?.decline_code ?? null,
    latest_charge: idOf(pi.latest_charge),
  };
}

export function projectCharge(charge: Stripe.Charge) {
  const card = charge.payment_method_details?.card;
  const outcome = charge.outcome;
  return {
    id: charge.id,
    object: "charge" as const,
    status: charge.status,
    paid: charge.paid,
    amount: charge.amount,
    currency: charge.currency,
    created: iso(charge.created),
    customer: idOf(charge.customer),
    payment_intent: idOf(charge.payment_intent),
    failure_code: charge.failure_code ?? null,
    failure_message: charge.failure_message ?? null,
    outcome: outcome
      ? {
          type: outcome.type,
          network_status: outcome.network_status ?? null,
          reason: outcome.reason ?? null,
          risk_level: outcome.risk_level ?? null,
          seller_message: outcome.seller_message ?? null,
        }
      : null,
    card: card
      ? {
          brand: card.brand ?? null,
          last4: card.last4 ?? null,
          exp_month: card.exp_month,
          exp_year: card.exp_year,
          funding: card.funding ?? null,
          country: card.country ?? null,
          cvc_check: card.checks?.cvc_check ?? null,
          three_d_secure_result: card.three_d_secure?.result ?? null,
        }
      : null,
  };
}

export function projectCustomer(customer: Stripe.Customer | Stripe.DeletedCustomer) {
  if ("deleted" in customer && customer.deleted === true) {
    return { id: customer.id, object: "customer" as const, deleted: true };
  }
  const live = customer as Stripe.Customer;
  return {
    id: live.id,
    object: "customer" as const,
    deleted: false,
    created: iso(live.created),
    email_masked: maskEmail(live.email),
    delinquent: live.delinquent ?? null,
  };
}

export function projectPaymentMethod(pm: Stripe.PaymentMethod) {
  const card = pm.card;
  return {
    id: pm.id,
    object: "payment_method" as const,
    type: pm.type,
    customer: idOf(pm.customer),
    card: card
      ? {
          brand: card.brand,
          last4: card.last4,
          exp_month: card.exp_month,
          exp_year: card.exp_year,
          funding: card.funding,
          country: card.country ?? null,
          cvc_check: card.checks?.cvc_check ?? null,
        }
      : null,
  };
}
