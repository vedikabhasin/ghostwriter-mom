# Portal walkthrough (Session B)

Two test members on RPR (`rpr-k7m2qx`). **Sam** (member) walks the whole flow on
a 375px phone, then again on desktop. **Patrick** (owner) checks the split from
the other side. Every screenshot here comes from `tests/portal/walkthrough.mjs`,
which also runs **84 checks**. The last run passed all 84 (`shots/results.json`).

| Test member | Email | Role | Avatar |
|---|---|---|---|
| Patrick | `vedikabhasin+rpr-owner@gmail.com` | owner (display name falls back to `contact_first_name`) | ghost (yellow) |
| Sam | `vedikabhasin+rpr-sam@gmail.com` | member | blob (violet) |

Both exist in the live project now (`supabase/seed/portal_test_rpr.sql`).
Remove them with `supabase/seed/portal_test_rpr_cleanup.sql`.

## How this was tested

- **Database (live project).** I impersonated Sam in SQL (`set role authenticated`
  plus JWT claims) inside transactions that roll back.
  - Allowed: reading the company's rows, `portal_decide` upserting and returning
    the previous action, `portal_set_live` toggling, Sam's own note, and Sam's
    own `onboarding`.
  - Blocked: a note as Patrick, direct `decisions` inserts, direct `articles`
    updates, Mark live on a ghost article, an outsider, the anon role, a bad
    action, and all writes once a canceled subscription has ended.
- **`invite-member`.** `tests/portal/invite-member.sh` runs the real function
  under Deno against a local Auth + PostgREST mock. All 9 checks pass: no token,
  not a member, invalid email, self-invite, more than 2 emails, seat limit, a
  successful invite (members row, avatar, redirect), and full.
- **UI.** Playwright drives Chromium against this repo. This container can't
  reach `*.supabase.co`, esm.sh, or PostHog, so the test intercepts them:
  - Supabase requests go to `tests/portal/sb-mock.mjs`, seeded with the exact
    rows the seed script leaves on RPR. It enforces the same rules as the
    RLS policies and RPCs.
  - The esm.sh import is served a local bundle of the same supabase-js 2.45.0,
    so the auth and query client is the real one.
  - PostHog calls are read back from the stub queue.

  What this doesn't cover: real email delivery, and the portal running against
  the live API from a browser. See "Try it for real" below.

## Phone (375 × 812)

| | |
|---|---|
| ![](shots/m01-signin.jpg) **Sign in.** One field. `signInWithOtp` with `shouldCreateUser: false`, redirecting to `/portal` (checked). | ![](shots/m02-link-sent.jpg) Same answer whether or not the email has a portal. |
| ![](shots/m03-feed-signal-onboarding.jpg) **Link lands signed in** (`portal_login` via link). The signal is the first card. "10 cards · 7 unread". Onboarding step 1. | ![](shots/m04-library-glow.jpg) Step 2: glow on the Library switch. |
| ![](shots/m05-agree.jpg) **Agree** (green): Patrick liked on the sales page, Sam liked. "New this week" on the latest drop. First Agree line. | ![](shots/m06-split.jpg) **Split** (pink): Patrick fast-tracked, Sam passed. Sam's stamp reads "Passed". First Split line: "Patrick wants to fast-track this. You passed. Leave a note?" |
| ![](shots/m07-note-sheet.jpg) **Add a note** (max 280). | ![](shots/m08-note-saved.jpg) "Saved to your Hub." Then the first-note line (`m08b`). |
| ![](shots/m09-timing.jpg) **Timing** (yellow): Patrick liked, Sam saved. Buttons sit at 25% opacity at rest (checked). Orange Refresh marker. | ![](shots/m10-changed-line.jpg) Sam changes save to like. The decision is upserted and a `swipe_event` (source `portal`) appended. First changed-decision line. |
| ![](shots/m11-drag-like.jpg) A real drag: the stamp tracks the gesture, and release records the like. | ![](shots/m12-sources.jpg) Source chips and bottom sheet, same as the sales page. |
| ![](shots/m13-history.jpg) **History**: every card, every member's action, dated. Sales-page swipes (member_id null) show as Patrick. | ![](shots/m14-upnext.jpg) **Up next**: Agree cards rank first. |
| ![](shots/m15-library.jpg) **Library**: a hand of cards. Pillar has the thick page edge and spine; ghosts are outlined. Step 3: the pencil glows. | ![](shots/m16-library-rotated.jpg) A swipe sends the top card to the back of the loop. |
| ![](shots/m17-ghost.jpg) **Ghost card**: "Approved, not written yet. Credits open soon." No prices. | ![](shots/m18-notified.jpg) Notify me: `article_interest`, plus a `wants_written` note. |
| ![](shots/m19-reader.jpg) **Reader** for `body_html`, with classes and styles stripped. | ![](shots/m20-copied.jpg) **Copy for web**: text/html and text/plain, headings kept (`shots/copied.html.txt`). |
| ![](shots/m21-marked-live.jpg) **Mark live** sets `status` and `live_at` (it also toggles back, checked). First live line. | ![](shots/m22-library-live.jpg) "Live" tag in the deck. |
| ![](shots/m23-invite.jpg) **First pencil tap** with 2 of 3 seats taken: one field, invalid email caught. | ![](shots/m24-hub-locked.jpg) **Locked Hub**: Sam's note, 3 book cards, and the top Agree cards, blurred under the overlay. |

## Desktop (1280 × 860)

| | |
|---|---|
| ![](shots/d01-feed.jpg) Arrow keys move between cards. | ![](shots/d02-feed-split-hover.jpg) Hover and focus brighten the buttons. The note shows on the card. |
| ![](shots/d03-library.jpg) | ![](shots/d04-reader.jpg) |
| ![](shots/d05-hub-locked.jpg) "Skip for now" opens the Hub. | |

## Edge states

| | |
|---|---|
| ![](shots/e01-no-membership.jpg) Signed in, no membership. | ![](shots/e02-expired-link.jpg) Expired link. |
| ![](shots/e03-readonly-library.jpg) Canceled and past `subscription_ends_at`: read-only Library plus the resubscribe line. No switch, no pencil. | ![](shots/e04-readonly-reader.jpg) Read-only reader: no Mark live. |
| ![](shots/e05-hub-unlocked.jpg) `hub_unlocked = true` with 3 members: the pencil goes straight in, unblurred, with the "Coming soon" line. | ![](shots/e06-owner-split.jpg) Patrick's side of the split: "Sam passed. You want this one. Leave a note?" His sales-page swipe counts as his own. |

## PostHog

Identify uses `member.id` only; `group('company', slug)`. No email appears in any call (checked).
Captured in the run: `portal_login, feed_swipe, decision_changed, dot_jump, overlap_seen,
note_added, library_open, article_copied, gdoc_opened, marked_live, ghost_tapped,
article_interest, hub_tapped, invite_sent, hub_locked_viewed` (`shots/posthog-calls.json`,
which is written just before the `gdoc_opened` click).

## Run it again

```bash
npm install
node tests/portal/walkthrough.mjs          # UI: screenshots here, exit 1 on any failed check
bash tests/portal/invite-member.sh         # edge function under Deno (npx deno works)
```

## Try it for real

1. Deploy (Netlify). `/portal` is rewritten in `netlify.toml`.
2. Supabase Auth → URL Configuration must list `https://www.ghostwriter.mom/portal`
   (see the root README). The default mailer only sends to your team's addresses,
   so use custom SMTP or your own address.
3. Open `/portal`, enter `vedikabhasin+rpr-sam@gmail.com`, and follow the link.
