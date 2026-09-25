// -----------------------------------------------------------------------------
// Stripe webhook — Deno edge function.
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
// -----------------------------------------------------------------------------
import Stripe from "https://esm.sh/stripe@14.25.0?target=denonext";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const STRIPE_SECRET_KEY     = Deno.env.get("STRIPE_SECRET_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PORTAL_REDIRECT       = Deno.env.get("PORTAL_REDIRECT") ?? "https://www.ghostwriter.mom/portal";

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// A tiny placeholder shape set. Session B will replace this with real monsters.
const AVATAR_SHAPES = ["blob", "worm", "ghost", "spike", "pebble", "curl"] as const;
const pickAvatar = () => AVATAR_SHAPES[Math.floor(Math.random() * AVATAR_SHAPES.length)];

// Look up an existing auth user by email — Supabase's admin API has no direct
// getUserByEmail, so we fall back to inviteUserByEmail and use its result;
// if the user already exists, we page through auth.users to find the id.
async function ensureAuthUser(email: string): Promise<string | null> {
  const invite = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: PORTAL_REDIRECT,
  });
  if (invite.data?.user?.id) return invite.data.user.id;

  // If the user already exists, the invite call errors. Locate by paging.
  let page = 1;
  const perPage = 200;
  while (page <= 25) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const hit = data.users.find(u => (u.email ?? "").toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < perPage) break;
    page += 1;
  }
  return null;
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const slug = (session.client_reference_id ?? "").trim();
  const email = session.customer_details?.email?.trim() ?? "";
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;

  let companyId: string | null = null;
  if (slug) {
    const { data, error } = await admin
      .from("companies")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw error;
    companyId = data?.id ?? null;
    if (!companyId) {
      console.warn("checkout.session.completed: unknown slug", slug, "event", session.id);
    }
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

  const userId = await ensureAuthUser(email);
  if (!userId) {
    console.error("could not resolve auth user for email", email);
    return;
  }

  if (companyId) {
    const { error } = await admin.from("members").upsert(
      {
        company_id:   companyId,
        user_id:      userId,
        role:         "owner",
        avatar_shape: pickAvatar(),
      },
      { onConflict: "company_id,user_id", ignoreDuplicates: false }
    );
    if (error) throw error;
  }
}

async function handleSubscriptionDeleted(sub: Stripe.Subscription) {
  const endsAt = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;
  const { error } = await admin
    .from("companies")
    .update({
      subscription_status:  "canceled",
      subscription_ends_at: endsAt,
    })
    .eq("stripe_subscription_id", sub.id);
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

  // Idempotency — insert-first. Duplicate id => 200 without re-processing.
  const dedupe = await admin.from("stripe_events").insert({ id: event.id });
  if (dedupe.error) {
    if (dedupe.error.code === "23505") return new Response("already processed", { status: 200 });
    console.error("dedupe insert failed", dedupe.error);
    return new Response("storage error", { status: 500 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
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
