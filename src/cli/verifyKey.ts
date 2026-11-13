import Stripe from "stripe";
import { loadDotEnv, readOnlyStripeKey } from "../config";

/*
 * Proves the agent's key is read-only at Stripe's API layer, not just in our code.
 * The write probe targets a customer id that does not exist, so it has no side effects
 * either way: a read-only key gets a permission error, a key with write access gets
 * "no such customer".
 */

loadDotEnv();
const stripe = new Stripe(readOnlyStripeKey(), { maxNetworkRetries: 1 });
const PROBE_ID = "cus_paymentlenswriteprobe";

async function main(): Promise<void> {
  await stripe.paymentIntents.list({ limit: 1 });
  console.log("PASS  read: listing PaymentIntents works");

  try {
    await stripe.customers.update(PROBE_ID, { description: "payment-lens write probe" });
    console.error("FAIL  write: the update succeeded. This key has write access; replace it.");
    process.exitCode = 1;
  } catch (err) {
    if (err instanceof Stripe.errors.StripePermissionError) {
      console.log("PASS  write: Stripe rejected the write with a permission error");
    } else if (err instanceof Stripe.errors.StripeInvalidRequestError && err.code === "resource_missing") {
      console.error("FAIL  write: Stripe looked up the customer, so this key has write access to Customers.");
      process.exitCode = 1;
    } else {
      console.error(`INCONCLUSIVE  write: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
