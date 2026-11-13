import Stripe from "stripe";

/**
 * The only Stripe surface the agent can reach. It exposes retrieve and list calls,
 * so even a misconfigured key cannot be used to write through this interface.
 */
export interface StripeReader {
  retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent>;
  retrieveCharge(id: string): Promise<Stripe.Charge>;
  retrieveCustomer(id: string): Promise<Stripe.Customer | Stripe.DeletedCustomer>;
  retrievePaymentMethod(id: string): Promise<Stripe.PaymentMethod>;
  listPaymentIntents(customerId: string, limit: number): Promise<Stripe.PaymentIntent[]>;
}

export function createStripeReader(apiKey: string): StripeReader {
  const stripe = new Stripe(apiKey, { maxNetworkRetries: 2, appInfo: { name: "payment-lens" } });
  return {
    retrievePaymentIntent: (id) => stripe.paymentIntents.retrieve(id),
    retrieveCharge: (id) => stripe.charges.retrieve(id),
    retrieveCustomer: (id) => stripe.customers.retrieve(id),
    retrievePaymentMethod: (id) => stripe.paymentMethods.retrieve(id),
    listPaymentIntents: async (customer, limit) => (await stripe.paymentIntents.list({ customer, limit })).data,
  };
}
