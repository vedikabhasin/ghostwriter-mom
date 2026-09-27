// -----------------------------------------------------------------------------
// create-checkout: Deno edge function, called by the portal to buy credits or
// to resume the $19.
// Deploy with:  supabase functions deploy create-checkout --no-verify-jwt
// verify_jwt is off (supabase/config.toml, ES256 sessions); the caller is
// checked here with admin.auth.getUser(token).
//
// Body: { action: "starter" | "plan" | "topup" | "resume", quantity?: number }
//   starter  5 credits, once per company
//   plan     20 credits a month (not while a plan is already running)
//   topup    `quantity` credits at $125 each
//   resume   the $19 is set to cancel at period end: turn that off on the
//            SAME subscription (no new charge, no new subscription)
// Credits need an active $19. The company's first credit purchase of any kind
// gets STRIPE_COUPON_FIRST_CREDITS ("Your $19 counts toward this.").
//
// Returns { url } for Stripe Checkout, or { resumed: true }.
// Errors: not_signed_in, not_a_member, internal, bad_action, bad_quantity,
// portal_inactive (+ can_resume), starter_used, plan_active, cannot_resume,
// not_configured, stripe_failed.
//
// Environment: STRIPE_SECRET_KEY, STRIPE_PRICE_STARTER, STRIPE_PRICE_PLAN,
// STRIPE_PRICE_TOPUP, STRIPE_COUPON_FIRST_CREDITS, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, PORTAL_REDIRECT (defaults to the live portal).
// -----------------------------------------------------------------------------
import Stripe from "https://esm.sh/stripe@14.25.0?target=denonext";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { PLAN_CREDITS, STARTER_CREDITS, TOPUP_MAX, stripeHostOptions, stripeIds, type Product } from "../_shared/credits.ts";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PORTAL_REDIRECT  = Deno.env.get("PORTAL_REDIRECT") ?? "https://www.ghostwriter.mom/portal";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
  ...stripeHostOptions(),
});
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  // Caller and company (the caller's oldest membership, like the portal).
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { error: "not_signed_in" });
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    console.error("getUser failed", userErr?.status, userErr?.message);
    return json(401, { error: "not_signed_in" });
  }
  const { data: memberRows, error: memberErr } = await admin.from("members")
    .select("id, company_id, created_at").eq("user_id", userData.user.id)
    .order("created_at", { ascending: true }).limit(1);
  if (memberErr) return json(500, { error: "lookup_failed" });
  const member = memberRows?.[0];
  if (!member) return json(403, { error: "not_a_member" });
  const { data: company, error: coErr } = await admin.from("companies")
    .select("id, slug, is_internal, subscription_status, subscription_ends_at, stripe_customer_id, stripe_subscription_id, plan_subscription_id")
    .eq("id", member.company_id).single();
  if (coErr || !company) return json(500, { error: "lookup_failed" });
  if (company.is_internal) return json(400, { error: "internal" });

  let body: { action?: string; quantity?: unknown };
  try { body = await req.json(); } catch { return json(400, { error: "bad_json" }); }
  const action = String(body.action ?? "");
  const canResume = company.subscription_status === "canceled" && !!company.stripe_subscription_id &&
    !!company.subscription_ends_at && new Date(company.subscription_ends_at) > new Date();

  // Resume: same subscription, cancel_at_period_end off. The webhook's
  // customer.subscription.updated confirms it; we flip the row now so the
  // portal can go straight on to the credit checkout.
  if (action === "resume") {
    if (!canResume) return json(409, { error: "cannot_resume" });
    try {
      const sub = await stripe.subscriptions.update(company.stripe_subscription_id!, { cancel_at_period_end: false });
      if (sub.status !== "active" && sub.status !== "trialing") return json(409, { error: "cannot_resume" });
    } catch (err) {
      console.error("resume failed", err instanceof Error ? err.message : err);
      return json(409, { error: "cannot_resume" });
    }
    const { error } = await admin.from("companies")
      .update({ subscription_status: "active", subscription_ends_at: null }).eq("id", company.id);
    if (error) return json(500, { error: "lookup_failed" });
    return json(200, { resumed: true });
  }

  if (!["starter", "plan", "topup"].includes(action)) return json(400, { error: "bad_action" });
  const product = action as Product;
  if (company.subscription_status !== "active") return json(409, { error: "portal_inactive", can_resume: canResume });

  const { data: grants, error: gErr } = await admin.from("credit_ledger")
    .select("product").eq("company_id", company.id).eq("kind", "grant").in("product", ["starter", "plan", "topup"]);
  if (gErr) return json(500, { error: "lookup_failed" });
  const firstPurchase = !grants?.length;
  if (product === "starter" && grants?.some((g) => g.product === "starter")) return json(409, { error: "starter_used" });
  if (product === "plan" && company.plan_subscription_id) return json(409, { error: "plan_active" });
  let quantity = 1;
  if (product === "topup") {
    quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > TOPUP_MAX) return json(400, { error: "bad_quantity" });
  }

  const ids = stripeIds();
  const price = ids[product];
  if (!price || (firstPurchase && !ids.coupon)) {
    console.error("create-checkout: missing Stripe price or coupon env for", product);
    return json(500, { error: "not_configured" });
  }
  const credits = product === "starter" ? STARTER_CREDITS : product === "plan" ? PLAN_CREDITS : quantity;
  const metadata = { company_id: company.id, kind: product, credits: String(credits), member_id: member.id };
  const back = new URL(PORTAL_REDIRECT);
  const success = new URL(back); success.searchParams.set("credits", "success"); success.searchParams.set("kind", product);
  const cancel = new URL(back); cancel.searchParams.set("credits", "cancel");

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: product === "plan" ? "subscription" : "payment",
    line_items: [{ price, quantity }],
    client_reference_id: company.slug,
    metadata,
    success_url: success.toString(),
    cancel_url: cancel.toString(),
    ...(company.stripe_customer_id ? { customer: company.stripe_customer_id } : { customer_email: userData.user.email ?? undefined }),
    ...(firstPurchase ? { discounts: [{ coupon: ids.coupon }] } : {}),
    ...(product === "plan" ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
  };
  try {
    const session = await stripe.checkout.sessions.create(params);
    return json(200, { url: session.url, first_purchase: firstPurchase });
  } catch (err) {
    console.error("checkout create failed", err instanceof Error ? err.message : err);
    return json(502, { error: "stripe_failed" });
  }
});
