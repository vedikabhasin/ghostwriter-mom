// -----------------------------------------------------------------------------
// Credit products, shared by create-checkout and stripe-webhook. Per-format
// costs live in the database (credit_costs()), not here.
//
//   Starter  5 credits, $495 one-time, once per company
//   Plan     20 credits, $2,000/month
//   Top-up   $125 per credit, any quantity, needs an active $19 portal
// A company's first credit purchase of any kind gets the $19 coupon.
//
// Environment (Stripe test mode first):
//   STRIPE_PRICE_STARTER, STRIPE_PRICE_PLAN, STRIPE_PRICE_TOPUP,
//   STRIPE_COUPON_FIRST_CREDITS
// -----------------------------------------------------------------------------
export type Product = "starter" | "plan" | "topup";

export const STARTER_CREDITS = 5;
export const PLAN_CREDITS = 20;
export const PLAN_ROLLOVER_CAP = 20;
export const PLAN_CANCEL_GRACE_DAYS = 60;
export const TOPUP_MAX = 100;

export function stripeIds() {
  return {
    starter: Deno.env.get("STRIPE_PRICE_STARTER") ?? "",
    plan:    Deno.env.get("STRIPE_PRICE_PLAN") ?? "",
    topup:   Deno.env.get("STRIPE_PRICE_TOPUP") ?? "",
    coupon:  Deno.env.get("STRIPE_COUPON_FIRST_CREDITS") ?? "",
  };
}

// Stripe client options. STRIPE_API_BASE points the SDK at a fake Stripe in
// tests; it is never set in production.
export function stripeHostOptions(): Record<string, unknown> {
  const base = Deno.env.get("STRIPE_API_BASE");
  if (!base) return {};
  const u = new URL(base);
  return { host: u.hostname, port: Number(u.port || (u.protocol === "https:" ? 443 : 80)), protocol: u.protocol.replace(":", "") };
}
