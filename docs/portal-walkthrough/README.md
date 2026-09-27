# Portal walkthrough: Vedika Bhasin (Session B)

The Vedika Bhasin portal (`vedika-bhasin-ycfogw`, `is_internal = true`) walked
through as **vedikabhasin@gmail.com** (owner) at 375px and on desktop, then from
the other side as **blendbases@gmail.com** (member). Every screenshot comes from
`tests/portal/walkthrough.mjs`, which also runs **272 checks** across four
account types (Vedika, a locked $19 account, an account with credits, RPR). The
last run passed all 272 (`shots/results.json`). The credit sections are at the end.

The test data is the live Vedika rows: the same article ids, series, statuses and
decisions, and the two seeded Hub notes (`tests/portal/fixture-vedika.mjs`).
Times are relative to the run: vb-01 was delivered 19h after it was requested,
and vb-05 is due in about 14h 20m.

## How this was tested

- Playwright drives Chromium against this repo. The container can't reach
  `*.supabase.co`, esm.sh or PostHog, so the test intercepts them:
  - Supabase goes to `tests/portal/sb-mock.mjs`, which enforces the same rules as
    the RLS policies and RPCs, including the `hub_items` insert policy.
  - esm.sh serves a local bundle of the same supabase-js 2.45.0.
  - PostHog calls are read back from the stub queue.
- Layout rules are measured, not eyeballed:
  - Peek cards match the front card's width, center and transform-origin, offset 6px/12px.
  - At least 16px between card, dots, actions and switch.
  - The glow stays off the dot slider.
  - AA contrast on Library titles, and no pixels from the cards behind showing through the front card.
  - Reveal entrances finish within 1.2s and animate only transform and opacity.
  - Desk objects never sit behind the login form.
- Not covered here: real email delivery, and the portal against the live API from
  a browser.

## 1. Feed with series labels

| | |
|---|---|
| ![](shots/m03-feed-signal-onboarding.jpg) Signal first, no content in the peeks. Onboarding step 1. | ![](shots/m04-feed-series.jpg) `VB` series label next to the format pill. "Add a note" is outlined with a pencil. |
| ![](shots/m05-feed-blendxr.jpg) `BlendXR` series. | ![](shots/d04-feed-series.jpg) Desktop. |

## 2. Overlap reveals

Each reveal fires once per card per member, the first time the card is seen, and
immediately for the member whose swipe creates the overlap. After that the card
shows the usual dot and label (`m10`).

| | |
|---|---|
| ![](shots/m06-reveal-agree.jpg) **vb-02 like → Agree.** Radial burst and floating hearts. "Move it up" pins the card to the top of Up next (`m11`). | ![](shots/m07-reveal-split.jpg) **vb-03 like → Split.** Diagonal two-color background; the avatars pull apart. |
| ![](shots/m09-reveal-timing.jpg) **vb-04 save → Timing.** Yellow wash and clock-hand sweep. | ![](shots/s04-reveal-reduced-motion.jpg) Reduced motion: the same overlay, static. |
| ![](shots/d06-reveal-agree.jpg) Desktop Agree. | ![](shots/d07-reveal-split.jpg) Desktop Split. |

## 3. A note from the Split reveal

| | |
|---|---|
| ![](shots/m08-note-from-reveal.jpg) "Leave a note". Saved to `notes` **and** as a `hub_items` row (kind `note`). | ![](shots/m18-hub-drag-pin.jpg) The note in the Hub with author avatar and linked card title, placed in the free slot next to the seeded rules notes. It never appears on the feed card. |

## 4. Library fan

| | |
|---|---|
| ![](shots/m12-library-delivered.jpg) **vb-01** "Delivered in 19h · Sep 26, 7:15 PM". Top card flat; two cards per side at ±5–8°. Pencil glows (onboarding). | ![](shots/m14-library-countdown.jpg) **vb-05** live countdown "Arriving in 14h 18m" (ticks every 30s). |
| ![](shots/m13-library-ghost.jpg) **bx-01** ghost: paper body, dashed teal border, "Approved" stamp, two dashed trails, "Ready to write · 1 credit". | ![](shots/m15-library-live.jpg) After Mark live: small ink "Live" tag. |

## 5. Hub

| | |
|---|---|
| ![](shots/m16-invite.jpg) First pencil tap with 2 of 3 seats: invite pop-up. | ![](shots/m17-hub.jpg) The fan unstacks onto the canvas. Seeded Rules and Cadence notes keep their positions. First-Hub line. |
| ![](shots/m18-hub-drag-pin.jpg) Drag saves x, y, rotation and z; 🔥 pinned onto an article travels with it. | ![](shots/m19-hub-show-hidden.jpg) Cadence hidden, then shown with "Show hidden" at 30% with Unhide. |
| ![](shots/m20-done-library.jpg) Done: the items fly back into the fan. | ![](shots/d17-hub.jpg) Desktop Hub. |

## 6. Internal switches

| | |
|---|---|
| ![](shots/s01-hub-locked.jpg) `?hub=locked`: blurred canvas, overlay copy, Back to Library. Nothing is written. | ![](shots/s02-hub-invite.jpg) `?hub=invite`: "One seat left on your portal." |
| ![](shots/s03-onboarding-reset.jpg) `?onboarding=reset`: flags cleared and saved, param removed, first-visit bubble again. | A non-internal company ignores the switches (checked). |

## 7. blendbases, from the other side

| | |
|---|---|
| ![](shots/b01-agree-other-side.jpg) Agree on first view of vb-02. | ![](shots/b02-split-other-side.jpg) Split: "You" passed, vedikabhasin liked. |
| ![](shots/b03-hub-other-side.jpg) Vedika's note in the shared Hub. | |

## 8. Login

| | |
|---|---|
| ![](shots/m01-login.jpg) "YOUR PORTAL" / "Welcome *back*." Desk objects stay at the edges. | ![](shots/m02-login-sent.jpg) After "Send me a link": "Check your inbox.", envelope, "The link works for 24 hours." |

## 9. Credits: a locked $19 account (Acme, no purchase yet)

Gating comes from account state (`portal_account()`), never from ids or names.

| | |
|---|---|
| ![](shots/c01-locked-library-ready.jpg) Library open at $19. Approved, unwritten cards carry "Ready to write · 3 credits". | ![](shots/c02-write-this-no-credits.jpg) "Write this": format defaults to the card's, cost updates live, "Get credits" at 0. |
| ![](shots/c03-starter-checkout-step.jpg) Never bought: Starter, "Your $19 counts toward this." Checkout gets the first-purchase coupon. | ![](shots/c04-invite-two-seats.jpg) First Hub tap: the invite pop-up, "Two seats left." from the real member count. |
| ![](shots/c05-invite-error.jpg) One message per error code: seat_limit, invalid_email, self_invite, already_member, failed. | ![](shots/c06-locked-hub.jpg) Locked Hub: blurred canvas, lock modal. The header seats and Invite stay above it. |
| ![](shots/c07-feed-last-two.jpg) Last two cards: the stack thins, the remaining dots pulse once. | ![](shots/c08-caught-up.jpg) Caught up: face-down stack (next week's first format face-up because those cards exist), drop day and countdown, a line per seat. |

## 10. Credits: the same account with a Starter pack and a plan month

| | |
|---|---|
| ![](shots/c09-write-this.jpg) 25 credits. Pillar = 8. A teammate's note is readable on the card. | ![](shots/c10-arriving.jpg) Spent: the piece goes straight to writing, "Arriving in 24h 0m", header 17 credits. |
| ![](shots/c11-queued.jpg) A second piece waits: "Queued". | ![](shots/c12-hub-write-this.jpg) Hub open (a purchase plus an active $19). Unwritten cards get the same "Write this". |
| ![](shots/c13-plan-or-topup.jpg) Bought before: plan (only if none running) or a top-up with a quantity picker. | ![](shots/c14-library-568.jpg) 375x568: the stamp stays on one line and the hint sits above the switch. |

## 11. RPR as it is live (the $19 set to cancel on Oct 25, no purchases)

| | |
|---|---|
| ![](shots/r01-rpr-feed.jpg) Feed and swipes stay open until Oct 25. The 10 updated cards. | ![](shots/r02-rpr-caught-up.jpg) Caught up: first opened on a Friday, so drops land on Fridays. No face-up card: next week's cards don't exist yet. |
| ![](shots/r03-rpr-hub-locked.jpg) Hub locked, one seat left. | ![](shots/r04-rpr-resume.jpg) "Resume your $19 to buy credits": one click resumes the same subscription, then straight into the Starter checkout. |

## PostHog

Identify uses `member.id` only; no email appears in any call (checked). Events
captured include `feed_swipe`, `overlap_seen`, `moved_up`, `library_open`,
`marked_live`, `hub_tapped`, `hub_opened`, `hub_item_moved`, `hub_pin_added` and
`hub_item_hidden` (`shots/posthog-calls.json`).

## Run it again

```bash
npm install
npm i --no-save --no-package-lock @electric-sql/pglite stripe@14.25.0
node tests/portal/walkthrough.mjs          # UI: screenshots here, exits 1 on any failed check
node tests/portal/credits-sql.test.mjs     # migrations + credit rules on PGlite
node tests/portal/stripe-webhook.test.mjs  # webhook under Deno
node tests/portal/create-checkout.test.mjs # checkout under Deno, fake Stripe
bash tests/portal/invite-member.sh         # invites under Deno
node validate-feeds.js
```
