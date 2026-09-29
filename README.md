# ghostwriter.mom

Static site (Netlify) + Supabase backend (Postgres + RLS + edge functions) +
Stripe (Payment Link) + PostHog (analytics).

## Layout

```
project/
  index.html                              # /            — waitlist landing
  swipe.html                              # /<slug>      — per-client sales page (catch-all rewrite)
  portal/                                 # /portal      — member portal (Feed, Library, Hub)
  clients/                                # source-of-truth JSON per client; imported to Supabase
  config/
    offer.json                            # earlyPrice, laterPrice (spots come from RPC)
    runtime.json                          # supabaseUrl / anon key / posthog key — replace REPLACE_ME
  supabase/
    migrations/                           # schema + RLS + RPCs
    functions/stripe-webhook/             # Deno edge function
    functions/invite-member/              # Hub invite pop-up (JWT required)
    seed/                                 # portal test fixture on RPR + cleanup
  tests/portal/                           # portal walkthrough (Playwright) + invite-member test
  docs/portal-walkthrough/                # screenshots + results of the walkthrough
  scripts/import-client.mjs               # push a client JSON into Supabase
  validate-feeds.js                       # build-time schema check for /clients/*.json
  netlify.toml                            # build, redirects, CSP + security headers
```

## Local checks

```bash
node validate-feeds.js         # schema-checks every clients/*.json
npm install                    # picks up @supabase/supabase-js for the import script
npm i --no-save --no-package-lock @electric-sql/pglite stripe@14.25.0
node tests/portal/credits-sql.test.mjs       # every migration on PGlite + the credit rules
node tests/portal/stripe-webhook.test.mjs    # webhook under Deno (needs deno on PATH)
node tests/portal/create-checkout.test.mjs   # checkout under Deno, fake Stripe
bash tests/portal/invite-member.sh           # invites under Deno
node tests/portal/walkthrough.mjs            # the portal in Chromium, every account type
```

## Manual setup (do this once, before first deploy)

Everything below is out-of-band configuration that only you can grant. Nothing
in this repo assumes it has been done — the sales page transparently falls
back to `/clients/*.json` if `config/runtime.json` is still `REPLACE_ME`, and
Stripe webhook + Auth setup are inert until wired up.

### 1. Supabase project

Create the project (any region; US-East keeps latency low with Netlify).

**Apply migrations** — three files in `supabase/migrations/`, in order:

```bash
supabase link --project-ref <your-ref>
supabase db push
```

Or paste each `.sql` into the SQL Editor in the Supabase dashboard, in the
order they are named (schema → RLS → RPCs).

**Auth settings** (Dashboard → Authentication → URL Configuration + Email):

- Site URL:                     `https://www.ghostwriter.mom`
- Additional Redirect URLs:     `https://www.ghostwriter.mom/portal`
                                `https://ghostwriter.mom/portal`
                                `http://localhost:8877/portal`   (dev)
- Magic Link expiry:            `86400`  (24 h; the invite in the Stripe
                                          webhook uses this same window)
- Email provider (SMTP):        Point at Resend / Postmark / your MX before
                                a real customer pays. The default Supabase
                                mailer rate-limits per project and is fine
                                for dev but not for a paid signup.
- Magic Link email template:    paste `emails/magic-link.html`
                                into Dashboard > Authentication > Email
                                Templates > Magic Link, with the subject
                                `Your Ghostwriter Mom sign-in`. It carries
                                both the link and the code the portal accepts.

**Environment (Dashboard → Settings → API):**

- Copy `Project URL` and `anon public` key into `config/runtime.json`:

  ```json
  {
    "supabaseUrl":     "https://xxxx.supabase.co",
    "supabaseAnonKey": "eyJ...",
    "posthogKey":      "phc_...",
    "posthogHost":     "https://us.i.posthog.com"
  }
  ```

- The `service_role` key stays out of the browser. Only used by the import
  script and the edge function.

### 2. Import RPR and the template into Supabase

```bash
export SUPABASE_URL="https://xxxx.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="eyJ..."   # service_role, not anon

node scripts/import-client.mjs clients/rpr-k7m2qx.json
node scripts/import-client.mjs clients/swipetemplate.json
```

The script is idempotent — re-run it whenever you edit a client JSON.

### 3. Stripe webhook (Supabase edge function)

Set the function's secrets (never checked in):

```bash
supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  PORTAL_REDIRECT=https://www.ghostwriter.mom/portal
```

Deploy the functions. `supabase/config.toml` turns platform JWT verification
off for all three: Stripe signs the webhook, and the project signs sessions
with ES256 keys that the legacy `verify_jwt` gate rejects, so `invite-member`
and `create-checkout` check the caller themselves with `admin.auth.getUser`.

```bash
supabase functions deploy stripe-webhook  --no-verify-jwt
supabase functions deploy invite-member   --no-verify-jwt
supabase functions deploy create-checkout --no-verify-jwt
```

Register the endpoint in Stripe (Dashboard → Developers → Webhooks):

- Endpoint URL:  `https://<your-ref>.functions.supabase.co/stripe-webhook`
- Events to send:
  - `checkout.session.completed` ($19, Starter, top-up, plan start)
  - `invoice.paid` (plan credits every month)
  - `customer.subscription.updated` ($19 cancel at period end, resume)
  - `customer.subscription.deleted` ($19 or plan ended)
- Copy the signing secret into `STRIPE_WEBHOOK_SECRET` above.

Stripe Payment Link (existing $19/mo): confirm it still passes
`client_reference_id` through to `checkout.session.completed`. Both current
links do (they were built with `?client_reference_id=<slug>` in the deploy
step).

### 3b. Credits in Stripe (test mode first)

"$19 decides, credits make." Create these in Stripe, in USD, then set the
four secrets:

| What | Stripe object | Secret |
|---|---|---|
| Starter: 5 credits, one-time | Price, one-time, $495 | `STRIPE_PRICE_STARTER` |
| Plan: 20 credits a month | Price, recurring monthly, $2,000 | `STRIPE_PRICE_PLAN` |
| Top-up: 1 credit | Price, one-time, $125 (the portal sends the quantity) | `STRIPE_PRICE_TOPUP` |
| First credit purchase: the $19 counts | Coupon, $19 off, duration once | `STRIPE_COUPON_FIRST_CREDITS` |

```bash
supabase secrets set STRIPE_PRICE_STARTER=price_... STRIPE_PRICE_PLAN=price_... \
  STRIPE_PRICE_TOPUP=price_... STRIPE_COUPON_FIRST_CREDITS=...
```

Until they are set, `create-checkout` answers `not_configured` and the portal
says checkout isn't set up yet. Costs per piece live in the database
(`credit_costs()`: post 1, insight 3, pillar 8; 1 credit = $100).

### 4. PostHog

Create a project (US region), grab the Project API Key
(`Project settings → Project API Key`) and paste into `runtime.json`. That's
it — the snippet in `swipe.html` initialises with
`person_profiles: 'identified_only'` and session recording off. Every event
carries `slug` as a super-property.

### 5. Deploy

```bash
netlify deploy --prod --dir=.
# already linked to ghostwriter-mom, no --site flag needed
```

## End-to-end test in Stripe test mode

1. Switch Stripe to Test mode. Copy a test-mode `STRIPE_SECRET_KEY` and a
   fresh test-mode `STRIPE_WEBHOOK_SECRET` into the edge function secrets.
2. Duplicate the $19 Payment Link in Test mode. Note its test URL.
3. Temporarily replace `stripeLink19` in `clients/rpr-k7m2qx.json` with the
   test link, re-run `import-client.mjs`, redeploy.
4. Open `https://www.ghostwriter.mom/rpr-k7m2qx?fresh=1`, swipe through, pick
   a free article, approve, hit **Unlock the portal**.
5. Complete Stripe test checkout with card `4242 4242 4242 4242`.
6. Confirm:
   - `companies` row for `rpr-k7m2qx` has `subscription_status='active'` and
     `stripe_subscription_id` populated.
   - `auth.users` has the checkout email.
   - `members` has one row for that user with `role='owner'`.
   - `stripe_events` has the `checkout.session.completed` id.
7. Restore the production Stripe link, re-import, redeploy.

## Portal (Session B)

`/portal` is a static page (`portal/`) on the same Supabase project. Members
read through RLS; the only new database objects are three functions in
`migrations/20260926000005_portal_rpcs.sql` (no table or column changes):

- `portal_decide(card_id, action)`: upserts the member's decision and appends a
  `swipe_events` row with source `portal`. RLS gives members no direct write
  on `decisions`.
- `portal_set_live(article_id, live)`: toggles delivered/live and sets `live_at`.
- `portal_can_write(company_id)`: false once a canceled subscription has ended.
  The portal is read-only Library at that point.

`invite-member` is deployed with the other functions above (JWT verification
off, the function checks the caller).

### Credits and pieces (`migrations/20260928000007_credits.sql` to `…009`)

- `credit_ledger`: append-only. A `grant` row holds credits and their expiry;
  every `spend`, `refund`, `expire` or `adjust` row points at its grant
  (`grant_id`). Balance = what's left on unexpired grants
  (`credit_balance(company)`). Spends take from the soonest-expiring grant
  first; refunds go back to the grant they came from.
- `pieces`: what credits buy. `spend_credits(article, format)` queues one; the
  first with nothing in `writing` starts at once (24h clock). Move statuses by
  hand in Supabase: `update pieces set status = 'delivered' where id = …;`
  Allowed: queued to writing or killed; writing to delivered or killed;
  delivered to revising (once), done or killed; revising to delivered or done.
  Killing a queued piece refunds it. The next queued piece starts when the
  one in writing leaves it.
- Hub access (`hub_access()`): internal, or already open (`hub_unlocked`),
  or a credit purchase with an active $19. It stays open at 0 credits.
- Seats: `companies.seat_limit` (default 3) drives the members trigger,
  `invite-member` and the portal. **Temporary:** RPR has `seat_limit = 4`
  and one test seat (vedikabhasinwork@gmail.com), leaving its 3 real seats
  empty. Before sending RPR their portal:
  `delete from members where company_id = (select id from companies where slug = 'rpr-k7m2qx') and user_id = (select id from auth.users where email = 'vedikabhasinwork@gmail.com');`
  then `update companies set seat_limit = 3 where slug = 'rpr-k7m2qx';`
- Adding credits by hand (internal portals, goodwill):
  `insert into credit_ledger (company_id, delta, kind, product) values ('…', 5, 'grant', 'manual');`

Walkthrough, screenshots and how to rerun the tests:
[`docs/portal-walkthrough/`](docs/portal-walkthrough/README.md).

## Data model notes for Session B (portal)

- Direction is derived, not stored — Session B should compute it from
  `decisions` per member with `member_id is not null`. The sales-page anon
  row (member_id null) is only used for the intro/approval flow.
- `articles` is where the portal reads. Free pick starts as
  `approved_unwritten`; you flip to `delivered` when the Google Doc lands,
  and `live` once the client publishes.
- `signals` is append-only; the portal shows the latest one.
- `notes` is empty by design — the Hub feature belongs to Session B.
- `hub_unlocked` on `companies` is the gate for the Hub view.

## Fallback / migration behaviour

The sales page adapter tries `get_feed` first and falls back to
`/clients/*.json` on failure (network, unknown slug, RLS misconfig). This
means:

- You can deploy `config/runtime.json` with real keys before the migrations
  land — the page still works from JSON.
- You can migrate one client at a time; whichever is imported to Supabase
  uses the RPC path, the rest use JSON.
- Once every client is imported and the RPC path is proven, delete the
  JSON files (or leave them as a build-time schema check — that's what
  `validate-feeds.js` is for).

The Netlify `approvals` form still fires on every approval alongside the
`submit_approval` RPC so you keep email notifications until Resend replaces
that flow.

## Active Netlify forms (post-Session-A)

| Form              | Where it lives              | Purpose |
|-------------------|-----------------------------|---------|
| `join-waitlist`   | `index.html`                | Homepage waitlist (email only) |
| `approvals`       | `swipe.html` (declared only) | Backup notification alongside `submit_approval` RPC |
| `portal-interest` | `swipe.html` (declared only) | Waitlist opt-in inside the sales flow when spots are full |

The `swipes` and `referrals` forms are gone (moved to `log_swipe` RPC and
Stripe's own confirmation page respectively). The `waitlist` and
`order-brief` forms are no longer emitted anywhere — archive them from the
Netlify Forms dashboard.
