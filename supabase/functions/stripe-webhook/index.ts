// -----------------------------------------------------------------------------
// Stripe webhook: Deno edge function.
// Deploy with:  supabase functions deploy stripe-webhook --no-verify-jwt
// (Stripe signs the payload; Supabase JWT verification would reject it.)
//
// Required environment (set with `supabase secrets set`):
//   STRIPE_SECRET_KEY           sk_live_… or sk_test_…
//   STRIPE_WEBHOOK_SECRET       whsec_…   (endpoint's signing secret)
//   SUPABASE_URL                already provided by Supabase runtime
//   SUPABASE_SERVICE_ROLE_KEY   already provided by Supabase runtime
//   PORTAL_REDIRECT             e.g. https://www.ghostwriter.mom/portal (Session B)
//
// The endpoint is idempotent: every event id is inserted into stripe_events
// first; a unique-violation means we've already handled it and return 200.
// Credit grants are idempotent a second time on their source id (checkout
// session or invoice), inside credits_grant().
//
// Events:
//   checkout.session.completed     $19 (Payment Link, client_reference_id =
//                                  slug), or a credit checkout from
//                                  create-checkout (metadata.kind = starter |
//                                  topup | plan)
//   invoice.paid                   plan invoice: +20 credits, expiring at the
//                                  end of the next billing period; carried-
//                                  over plan credits above 20 expire
//   customer.subscription.updated  $19 cancel_at_period_end on / off
//   customer.subscription.deleted  $19 ended: canceled, every credit expires
//                                  plan ended: credits get up to 60 more days
// Internal companies (is_internal) are ignored everywhere.
// -----------------------------------------------------------------------------
import Stripe from "https://esm.sh/stripe@14.25.0?target=denonext";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  PLAN_CANCEL_GRACE_DAYS, PLAN_CREDITS, PLAN_ROLLOVER_CAP, STARTER_CREDITS, stripeHostOptions, stripeIds,
} from "../_shared/credits.ts";

const STRIPE_SECRET_KEY     = Deno.env.get("STRIPE_SECRET_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PORTAL_REDIRECT       = Deno.env.get("PORTAL_REDIRECT") ?? "https://www.ghostwriter.mom/portal";

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
  ...stripeHostOptions(),
});
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// The six avatar shapes; the portal draws them as monsters (portal/avatars.js).
const AVATAR_SHAPES = ["blob", "worm", "ghost", "spike", "pebble", "curl"] as const;
const pickAvatar = () => AVATAR_SHAPES[Math.floor(Math.random() * AVATAR_SHAPES.length)];

// Find or create the payer's auth user WITHOUT sending email. Creating the
// user and the membership must not depend on the mailer: inviteUserByEmail
// rolls the user back when the email fails, which used to leave a paid
// customer with no portal and Stripe with a 200 (so no retry).
async function findAuthUser(email: string): Promise<string | null> {
  const perPage = 200;
  for (let page = 1; page <= 25; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const hit = data.users.find(u => (u.email ?? "").toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < perPage) break;
  }
  return null;
}

async function ensureAuthUser(email: string): Promise<string> {
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.data?.user?.id) return created.data.user.id;
  // Most likely the user already exists (a returning customer).
  const existing = await findAuthUser(email);
  if (existing) return existing;
  throw new Error(`could not create or find auth user: ${created.error?.message ?? "unknown"}`);
}

// Best effort: a mailer failure is logged, never thrown. The member can
// always request a fresh link from /portal ("Send me a link").
async function sendPortalLink(email: string) {
  const { error } = await admin.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: PORTAL_REDIRECT },
  });
  if (error) console.error("portal link email failed (member still created)", email, error.message);
}

const idOf = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : x?.id ?? null);

type Company = {
  id: string; is_internal: boolean; subscription_status: string;
  stripe_subscription_id: string | null; plan_subscription_id: string | null; stripe_customer_id: string | null;
};
const COMPANY_COLS = "id, is_internal, subscription_status, stripe_subscription_id, plan_subscription_id, stripe_customer_id";

async function companyBy(col: string, value: string | null): Promise<Company | null> {
  if (!value) return null;
  const { data, error } = await admin.from("companies").select(COMPANY_COLS).eq(col, value).maybeSingle();
  if (error) throw error;
  return (data as Company) ?? null;
}

async function grant(companyId: string, amount: number, product: string, sourceId: string, expiresAt: string | null, cap: number | null) {
  const { data, error } = await admin.rpc("credits_grant", {
    p_company_id: companyId, p_amount: amount, p_product: product, p_source_id: sourceId,
    p_expires_at: expiresAt, p_rollover_cap: cap,
  });
  if (error) throw error;
  console.log("credits_grant", product, amount, sourceId, data ? "granted" : "already granted");
}

// Starter and top-up land here; a plan checkout only records the plan
// subscription (its credits come with invoice.paid).
async function handleCreditCheckout(session: Stripe.Checkout.Session) {
  const md = session.metadata ?? {};
  const company = await companyBy("id", md.company_id ?? null);
  if (!company) { console.warn("credit checkout: unknown company", md.company_id, session.id); return; }
  if (company.is_internal) { console.log("credit checkout: ignoring internal company", session.id); return; }
  const customerId = idOf(session.customer as string | null);
  if (customerId && !company.stripe_customer_id) {
    const { error } = await admin.from("companies").update({ stripe_customer_id: customerId }).eq("id", company.id);
    if (error) throw error;
  }
  if (md.kind === "plan") {
    const { error } = await admin.from("companies")
      .update({ plan_subscription_id: idOf(session.subscription as string | null) }).eq("id", company.id);
    if (error) throw error;
    return;
  }
  if (session.payment_status !== "paid") { console.warn("credit checkout not paid yet", session.id); return; }
  const amount = md.kind === "starter" ? STARTER_CREDITS : Math.max(0, parseInt(md.credits ?? "0", 10));
  if (!amount) throw new Error("credit checkout without a credit amount: " + session.id);
  // Starter and top-up credits don't expire while the $19 is active.
  await grant(company.id, amount, md.kind, session.id, null, null);
}

// Plan invoice: +20, expiring at the end of the next billing period.
async function handleInvoicePaid(invoice: Stripe.Invoice) {
  const ids = stripeIds();
  const subId = idOf(invoice.subscription as string | null);
  const line = invoice.lines?.data?.find((l) => l.price?.id === ids.plan);
  const md = (invoice.subscription_details?.metadata ?? {}) as Record<string, string>;
  if (!line && md.kind !== "plan") return; // the $19 invoice, or anything else
  const company = (await companyBy("id", md.company_id ?? null)) ??
    (await companyBy("plan_subscription_id", subId)) ??
    (await companyBy("stripe_customer_id", idOf(invoice.customer as string | null)));
  if (!company) { console.warn("invoice.paid: no company for plan invoice", invoice.id); return; }
  if (company.is_internal) { console.log("invoice.paid: ignoring internal company", invoice.id); return; }
  const start = line?.period?.start ?? invoice.period_start;
  const end = line?.period?.end ?? invoice.period_end;
  const expires = new Date((end + (end - start)) * 1000).toISOString();
  const { error } = await admin.from("companies")
    .update({ plan_subscription_id: subId, plan_period_end: new Date(end * 1000).toISOString() })
    .eq("id", company.id);
  if (error) throw error;
  await grant(company.id, PLAN_CREDITS, "plan", invoice.id, expires, PLAN_ROLLOVER_CAP);
}

// $19 cancel_at_period_end: canceled-but-not-ended. Resuming clears it.
async function handleSubscriptionUpdated(sub: Stripe.Subscription) {
  const company = await companyBy("stripe_subscription_id", sub.id);
  if (!company || company.is_internal) return;
  const ending = !!sub.cancel_at_period_end;
  const patch = ending
    ? { subscription_status: "canceled", subscription_ends_at: new Date(sub.current_period_end * 1000).toISOString() }
    : sub.status === "active" ? { subscription_status: "active", subscription_ends_at: null } : null;
  if (!patch) return;
  const { error } = await admin.from("companies").update(patch).eq("id", company.id);
  if (error) throw error;
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  if (["starter", "topup", "plan"].includes(session.metadata?.kind ?? "")) return handleCreditCheckout(session);
  const slug = (session.client_reference_id ?? "").trim();
  const email = session.customer_details?.email?.trim() ?? "";
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;

  let companyId: string | null = null;
  let companyIsInternal = false;
  if (slug) {
    const { data, error } = await admin
      .from("companies")
      .select("id, is_internal")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw error;
    companyId = data?.id ?? null;
    companyIsInternal = !!data?.is_internal;
    if (!companyId) {
      console.warn("checkout.session.completed: unknown slug", slug, "event", session.id);
    }
  }

  // Internal companies (Vedika Bhasin's personal portal, etc.) never have
  // their subscription_status flipped by Stripe. Their state is managed by
  // hand. We return without touching anything so a stray checkout (most
  // likely a test) is a no-op.
  if (companyIsInternal) {
    console.log("checkout.session.completed: ignoring internal company", slug, "event", session.id);
    return;
  }

  if (companyId) {
    const { error } = await admin
      .from("companies")
      .update({
        subscription_status:    "active",
        subscription_ends_at:   null,
        stripe_customer_id:     customerId,
        stripe_subscription_id: subscriptionId,
      })
      .eq("id", companyId);
    if (error) throw error;
  }

  if (!email) {
    console.warn("checkout.session.completed: no email on session", session.id);
    return;
  }

  // Throws on failure -> 500 -> the dedupe row is removed and Stripe retries.
  const userId = await ensureAuthUser(email);

  if (companyId) {
    // Update-then-insert rather than upsert: the 3-member cap trigger fires on
    // any INSERT attempt, so an upsert would fail for a returning owner on a
    // full team.
    const { data: existing, error: selErr } = await admin
      .from("members").select("id")
      .eq("company_id", companyId).eq("user_id", userId).maybeSingle();
    if (selErr) throw selErr;
    const { error } = existing
      ? await admin.from("members").update({ role: "owner" }).eq("id", existing.id)
      : await admin.from("members").insert({
          company_id:   companyId,
          user_id:      userId,
          role:         "owner",
          avatar_shape: pickAvatar(),
        });
    if (error) throw error;
  }

  await sendPortalLink(email);
}

async function handleSubscriptionDeleted(sub: Stripe.Subscription) {
  // The plan ending never touches the portal. Its credits get up to 60 more
  // days if the $19 is still active.
  const planCo = await companyBy("plan_subscription_id", sub.id);
  if (planCo) {
    if (planCo.is_internal) return;
    const { error } = await admin.from("companies").update({ plan_subscription_id: null }).eq("id", planCo.id);
    if (error) throw error;
    if (planCo.subscription_status === "active") {
      const r = await admin.rpc("credits_extend", { p_company_id: planCo.id, p_days: PLAN_CANCEL_GRACE_DAYS });
      if (r.error) throw r.error;
    }
    return;
  }
  // The $19 ended: every credit expires.
  const portalCo = await companyBy("stripe_subscription_id", sub.id);
  if (portalCo && !portalCo.is_internal) {
    const r = await admin.rpc("credits_expire_all", { p_company_id: portalCo.id, p_source_id: sub.id });
    if (r.error) throw r.error;
  }
  const endsAt = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;
  // Guard: internal companies are never touched by Stripe. In practice their
  // stripe_subscription_id is null so the update would no-op, but making the
  // filter explicit protects against a rare id collision.
  const { error } = await admin
    .from("companies")
    .update({
      subscription_status:  "canceled",
      subscription_ends_at: endsAt,
    })
    .eq("stripe_subscription_id", sub.id)
    .eq("is_internal", false);
  if (error) throw error;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const signature = req.headers.get("stripe-signature");
  const raw = await req.text();
  if (!signature) return new Response("missing signature", { status: 400 });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("signature verification failed", err instanceof Error ? err.message : err);
    return new Response("bad signature", { status: 400 });
  }

  // Idempotency: insert-first. Duplicate id => 200 without re-processing.
  const dedupe = await admin.from("stripe_events").insert({ id: event.id });
  if (dedupe.error) {
    if (dedupe.error.code === "23505") return new Response("already processed", { status: 200 });
    console.error("dedupe insert failed", dedupe.error);
    return new Response("storage error", { status: 500 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
    } else if (event.type === "invoice.paid") {
      await handleInvoicePaid(event.data.object as Stripe.Invoice);
    } else if (event.type === "customer.subscription.updated") {
      await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
    } else if (event.type === "customer.subscription.deleted") {
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
    } else {
      // Types we don't process are still recorded as processed so Stripe stops
      // retrying. If we start caring about a type later, remove its id from
      // stripe_events by hand and replay from the Stripe dashboard.
    }
  } catch (err) {
    console.error("handler error", event.type, err instanceof Error ? err.message : err);
    // Delete the dedupe row so Stripe's retry will actually re-run us.
    await admin.from("stripe_events").delete().eq("id", event.id);
    return new Response("handler error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
