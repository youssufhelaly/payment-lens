import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import Stripe from "stripe";
import { loadDotEnv, seedStripeKey } from "../config";
import { CUSTOMERS, SCENARIOS, type CustomerKey, type ScenarioDef } from "../scenarios";
import { saveSeedData, SEED_FILE, type SeededData } from "../seedData";

loadDotEnv();
const stripe = new Stripe(seedStripeKey(), { maxNetworkRetries: 2 });
const runId = randomUUID().slice(0, 8);
// Idempotency keys make a retried or interrupted seed safe: Stripe returns the original
// object instead of creating a duplicate.
const idem = (...parts: string[]) => ({ idempotencyKey: ["payment-lens", runId, ...parts].join(":") });

async function createCustomers(): Promise<Record<CustomerKey, string>> {
  const ids = {} as Record<CustomerKey, string>;
  for (const key of Object.keys(CUSTOMERS) as CustomerKey[]) {
    const { name, email } = CUSTOMERS[key];
    const customer = await stripe.customers.create(
      { name, email, metadata: { payment_lens_run: runId } },
      idem("customer", key),
    );
    ids[key] = customer.id;
  }
  return ids;
}

async function paymentMethodFor(scenario: ScenarioDef): Promise<string> {
  if ("paymentMethod" in scenario.card) return scenario.card.paymentMethod;
  const pm = await stripe.paymentMethods.create(
    { type: "card", card: { token: scenario.card.token } },
    idem("pm", scenario.id),
  );
  return pm.id;
}

function paymentIntentFromError(err: unknown): Stripe.PaymentIntent | null {
  if (err instanceof Stripe.errors.StripeError) return err.payment_intent ?? null;
  return null;
}

async function seedScenario(scenario: ScenarioDef, customerId: string): Promise<Stripe.PaymentIntent> {
  if (scenario.delayBeforeMs) await sleep(scenario.delayBeforeMs);
  const params: Stripe.PaymentIntentCreateParams = {
    amount: scenario.amount,
    currency: "usd",
    customer: customerId,
    payment_method: await paymentMethodFor(scenario),
    allowed_payment_method_types: ["card"],
    confirm: true,
    metadata: { payment_lens_run: runId },
    ...(scenario.description ? { description: scenario.description } : {}),
  };
  try {
    return await stripe.paymentIntents.create(params, idem("pi", scenario.id));
  } catch (err) {
    // Declines throw a card error, but the PaymentIntent still exists with the failure recorded.
    const pi = paymentIntentFromError(err);
    if (pi) return pi;
    throw err;
  }
}

async function main(): Promise<void> {
  console.log(`Seeding run ${runId} in Stripe test mode...`);
  const customers = await createCustomers();
  const seeded: SeededData["scenarios"] = [];
  const failures: string[] = [];

  for (const scenario of SCENARIOS) {
    try {
      const pi = await seedScenario(scenario, customers[scenario.customer]);
      seeded.push({ id: scenario.id, paymentIntentId: pi.id, customerId: customers[scenario.customer], status: pi.status });
      const error = pi.last_payment_error;
      const detail = error ? `${error.code ?? ""} ${error.decline_code ?? ""}`.trim() : "";
      console.log(`  ${scenario.id.padEnd(26)} ${pi.id}  ${pi.status}${detail ? `  (${detail})` : ""}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(scenario.id);
      console.error(`  ${scenario.id.padEnd(26)} FAILED: ${message}`);
    }
  }

  await saveSeedData({ createdAt: new Date().toISOString(), runId, customers, scenarios: seeded });
  console.log(`\nWrote ${seeded.length} scenarios to ${SEED_FILE}.`);
  if (failures.length > 0) {
    console.error(`${failures.length} scenario(s) failed: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
