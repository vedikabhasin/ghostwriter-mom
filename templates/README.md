# Sales page templates

Every slug config in `clients/<slug>.json` names its template:

| Template | File | Preview route | Used by |
|---|---|---|---|
| `rpr` | `templates/rpr.html` | `/rprtemplate` | `rpr-k7m2qx` |
| `swipe1` | `templates/swipe1.html` | `/swipe1template` (`/swipetemplate` redirects here) | every lead slug |
| `swipe2` | `templates/swipe2.html` | `/swipe2template` | nothing yet (flow `collab3`) |

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

## swipe2: flow collab3

Built from the frozen swipe1 page, with these changes: a 3-card deck; Keep
and Pass labels; save and fast-track shown locked (no gesture, no click); the
pick step replaced by the collab screen (both reactions per card, Match /
Split / Pass, the auto-picked article with the email field, a locked portal
preview, "Unlock portal now" to Cal.com).

Auto-pick: the first Match in writeOn order, else the first card the visitor
kept, else the first card in writeOn.

State lives in Supabase, keyed by slug (migration 20261001000015): swipes and
reactions through log_swipe, the pick through set_collab_pick (first write
wins), the approval through submit_approval, all read back by
get_collab_state. Every device on the link sees the same swipes, pick, log
and sent state. localStorage is a cache; swipes found only there are written
to the database on first load.

Tests: `tests/sales/collab3.test.mjs` (browser, three devices) and
`tests/sales/collab-state.test.mjs` (SQL).

## Slug config fields

| Field | Required | Values |
|---|---|---|
| `template` | yes | `rpr`, `swipe1`, `swipe2` |
| `leadType` | no | `warm`, `cold`, `partner` (PostHog shows `unset` when missing) |
| `flow` | no | any string; default `swipe_pick_<unlock mode>`. Required `collab3` on swipe2 |
| `vediReactions` | collab3 | `{ "<cardId>": "like" \| "pass" }` for every card |
| `writeOn` | collab3 | every card id once, in writing order |
| `lockedCount` | collab3 | directions the call unlocks (integer) |

## PostHog

`/shared/track.js` registers on every page load, on every event:
`template`, `slug`, `lead_type`, `cards_count`, `flow`.

Shared event names on every template: `page_open`, `deal_me_in`,
`first_swipe`, `swipe_complete`, `email_submitted`, `unlock_clicked`.
collab3 adds `collab_view_seen`, `article_auto_picked` and
`local_swipes_migrated`.
The older per-step events (`intro_viewed`, `swipe`, `deck_completed`, ...)
still fire next to them so existing dashboards keep working.
