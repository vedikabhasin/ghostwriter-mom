# Sales page templates

Every slug config in `clients/<slug>.json` names its template:

| Template | File | Preview route | Used by |
|---|---|---|---|
| `rpr` | `templates/rpr.html` | `/rprtemplate` | `rpr-k7m2qx` |
| `swipe1` | `templates/swipe1.html` | `/swipe1template` (`/swipetemplate` redirects here) | every lead slug |
| `swipe2` | `templates/swipe2.html` | `/swipe2template` | nothing yet |

## Routing

`node validate-feeds.js` (the Netlify build command) validates every config
and writes `/_redirects`: one rewrite per slug to its template file. The
browser URL never changes, so live slug links stay as they are. Netlify reads
`_redirects` before `netlify.toml`; a slug with no config file still falls
through to the old `/:slug` rule and `swipe.html`.

`swipe.html` is the pre-template copy. No configured slug routes to it; it
stays for config-less slugs and for the portal tests that drive it.

## Rules

- `rpr` and `swipe1` are frozen copies of the page as it was live on
  2026-10-01 (RPR at 10 cards; General Robotics at 5 cards, intro and pick
  step). Change them only to fix a live bug.
- RPR terminology stays RPR-only. An `rpr` config uses the pillar / insight /
  post formats; every other template uses long_form / short_insight /
  linkedin_post. The build fails otherwise.
- No em dashes in page copy. The build fails on an em dash in a routed config.

## swipe2

Built from the frozen swipe1 page (intro, card stack, swipe gesture, heart and
X buttons). Changes: the intro plays the waitlist's original desk scatter
(emojis fly out from the centre) and 2.5s later deals the 3 deck cards,
blurred, around the text and behind it; 3 cards; Keep and Pass labels; save and fast-track locked;
portal progress dots and a dark first-card tooltip; Vedika's reaction about
700ms after each swipe (the portal's match moment for two likes, its split
moment for a split, a PASS toast for two passes); then the final screen: where
the article lands, and a PORTAL frame with the real Log and locked Signals,
Library and Hub, with one CTA to Cal.com.

Portal visuals are copied, not imported, into `templates/kit/` (portal-kit.css
and portal-kit.js name the portal lines they came from). The portal files are
never read at runtime.

Auto-pick: the first Match in writeOn order, else the first card the visitor
kept, else the first card in writeOn. The pick, its delivery time (pick + 24h)
and a snapshot of vediReactions are stored once; only the device that stored
them creates the approval and posts the Netlify approvals form. Preview routes
ending in `template` never notify.

State lives in Supabase, keyed by slug (migration 20261001000015): swipes and
the log through log_swipe, the pick through set_collab_pick (first write
wins), all read back by get_collab_state. A new device or a colleague sees the
same swipes, pick and log; a finished deck opens on the final screen.
localStorage is a cache; swipes found only there are written to the database
on first load.

Tests: `tests/sales/swipe2.test.mjs` (browser, five devices) and
`tests/sales/collab-state.test.mjs` (SQL).

## Slug config fields

rpr and swipe1:

| Field | Required | Values |
|---|---|---|
| `template` | yes | `rpr`, `swipe1` |
| `leadType` | no | `warm`, `cold`, `partner` (PostHog shows `unset` when missing) |
| `flow` | no | any string; default `swipe_pick_<unlock mode>` |

swipe2 has its own shape:

| Field | Values |
|---|---|
| `template` | `swipe2` |
| `company`, `contactFirstName`, `sourceLine` | strings |
| `cards` | exactly 3, lead formats |
| `vediReactions` | `{ "<cardId>": "like" \| "pass" }` for every card |
| `writeOn` | every card id once, in writing order |
| `lockedCount` | directions the call unlocks (integer) |
| `deliveryChannel` | `LinkedIn` (shows "LinkedIn messages") or `email` (shows "inbox") |
| `lead_type` | `warm` or `cold` |
| `flow` | optional; default `live_reveal` |

`scripts/import-client.mjs` maps company, sourceLine and contactFirstName to
the database columns.

## PostHog

`/shared/track.js` registers on every page load, on every event:
`template`, `slug`, `lead_type`, `cards_count`, `flow`.

Shared event names on every template: `page_open`, `deal_me_in`,
`first_swipe`, `swipe_complete`, `email_submitted`, `unlock_clicked`.
swipe2 adds `match_seen`, `split_seen`, `article_auto_picked`, `log_viewed`
and `local_swipes_migrated`.
The older per-step events (`intro_viewed`, `swipe`, `deck_completed`, ...)
still fire next to them so existing dashboards keep working.
