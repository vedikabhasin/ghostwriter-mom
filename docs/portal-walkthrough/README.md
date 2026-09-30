# Portal walkthrough: call mode

Every screenshot here comes from `tests/portal/walkthrough.mjs`, which runs
**376 checks** across these accounts:

- **Vedika** (`vedika-bhasin-ycfogw`, internal) at 375px and on desktop, then
  **blendbases** from the other side.
- **Acme**, a client opened on the call with a 30-day `portal_access_until`
  window. It appears three ways: inside the window, after it closed, and with
  a credit grant added by hand.
- **A three-seat team.**
- **RPR** as it is live: canceled, no window, one test seat.
- **Sign in with a code.**

The last run passed all 376 (`shots/results.json`).

## How this was tested

- Playwright drives Chromium against this repo. The container can't reach
  `*.supabase.co`, esm.sh or PostHog, so the test intercepts them:
  - Supabase goes to `tests/portal/sb-mock.mjs`, which mirrors
    `portal_active()`, `hub_access()`, `request_card` and the RLS rules.
  - esm.sh serves a local bundle of the same supabase-js 2.45.0.
  - The `portal-request` Netlify form posts are recorded.
- The SQL side (window, requests, open swipes after the window, Hub access
  from a credit grant, the 24h clock) runs against real Postgres in
  `tests/portal/credits-sql.test.mjs`.
- `scripts/reset-company.mjs` has its own test, `tests/portal/reset-company.test.mjs`.
- Not covered here: real email delivery, the live Netlify form inbox, and the
  portal against the live API from a browser.

## Patrick-call path: add-owner (`tests/portal/add-owner.test.mjs`, 14 checks)

swipetemplate in memory: 5 anonymous swipes on the sales page, then the real
`scripts/add-owner.mjs swipetemplate vedikabhasin+owner@gmail.com --name "Test"`
and `scripts/reset-company.mjs --member` against `tests/portal/service-mock.mjs`
(the service API), code sign-in in between.

| | |
|---|---|
| ![](shots/o01-owner-log.jpg) Log: "5 calls logged." | ![](shots/o02-owner-library.jpg) Library: "0 delivered · 3 up next". |

## Formats

Labels and colors come from `/shared/formats.js` when it is deployed (the
sales branch owns it); until then, and for any key it leaves out, each format
takes its family color: pillar, guide (pillar); insight, article, comparison,
explainer, data (insight); post, byline, carousel (post).

| | | |
|---|---|---|
| ![](shots/f-guide.jpg) Guide, pillar family. | ![](shots/f-comparison.jpg) Comparison, insight family. | ![](shots/f-carousel.jpg) Carousel, post family. |
| ![](shots/f-guide-request.jpg) Request sheet: the card's own format first. | ![](shots/f-shared-map-data.jpg) With a `/shared/formats.js` served: its label wins. | ![](shots/x-favicon.jpg) `/favicon.ico` |

Every format has its own shot: `shots/f-<format>.jpg`.

## Sign in (§2)

| | |
|---|---|
| ![](shots/m01-login.jpg) Email, "Send me a link". | ![](shots/m02-login-sent.jpg) Same card: "Check your inbox. The link and the code work for 24 hours." and "Or enter the code from your email". |
| ![](shots/k01-code-wrong.jpg) Wrong code: the exact copy and "Send a new link". | ![](shots/k02-code-signed-in.jpg) Signed in with an 8-digit pasted code. |

## Reveals (§5)

| | |
|---|---|
| ![](shots/m06-reveal-agree.jpg) Both liked: "Two yeses. Next in line." | ![](shots/m09b-reveal-now.jpg) Both fast-tracked: "You both want it now. Lock it in." |
| ![](shots/m07-reveal-split.jpg) Split: "Split decision. Best note wins." | ![](shots/m09-reveal-timing.jpg) Save vs like: "Same yes, different week." |
| ![](shots/m08-note-from-reveal.jpg) "Make your case" prefilled "Liked because ". | ![](shots/c06-three-seat-split.jpg) Three seats, all different: Split. |
| ![](shots/s04-reveal-reduced-motion.jpg) Reduced motion: the final frame. | ![](shots/x02-closed-reveal.jpg) Window closed: "Request it" disabled with the reason. |

## Card statuses and requests (§4)

| | |
|---|---|
| ![](shots/m12-library-delivered.jpg) DELIVERED, one-line stamp. | ![](shots/m13-library-writing.jpg) WRITING, "ARRIVING IN 14H 20M". |
| ![](shots/m14-library-upnext.jpg) UP NEXT. | ![](shots/m15-sheet-request.jpg) "Request this" with the card's format preselected. |
| ![](shots/m16-sheet-requested.jpg) After one tap: stamp, "Requested by {Name} · {Mon D}. Vedika confirms timing." | ![](shots/c01-requested-from-library.jpg) Acme: another format, form posted. |

## Empty feed (§6) and invites (§3)

| | |
|---|---|
| ![](shots/c02-feed-last-two.jpg) Last two cards: the stack thins, the dots pulse once. | ![](shots/c03-empty-feed.jpg) Paper card with the next drop, "Lee hasn’t seen 5 of these.", "Seat 3 is open." |
| ![](shots/m17-invite.jpg) First Hub tap: "They’ll get a sign-in link. One seat left on your portal." | ![](shots/c04-invite-error.jpg) Error copy. |
| ![](shots/s02-invite-sent.jpg) Sent: stays open, new seat, "Invite sent to …". | |

## Hub (§7)

| | |
|---|---|
| ![](shots/c05-locked-hub.jpg) Locked: invite first, then "Your Hub opens with your first content pack." Invite and the + seat ghost sit above the blur. | ![](shots/s01-hub-locked.jpg) `?hub=locked` on the internal portal: its own items only. |
| ![](shots/m18-hub.jpg) Unlocked, with UP NEXT cards on the canvas. | ![](shots/m19-hub-show-hidden.jpg) Show hidden: the hidden Cadence note moves clear instead of covering Rules. |

## Window closed (§1)

| | |
|---|---|
| ![](shots/x01-closed-feed.jpg) Banner on every view; swiping still works. | ![](shots/x03-closed-request-disabled.jpg) "Request this" disabled with "Your window closed. Book 15 minutes to keep going." |
| ![](shots/r01-rpr-feed.jpg) RPR as live (canceled, no window). | ![](shots/r02-rpr-hub-locked.jpg) RPR Hub, three seats open of four. |

## Layout (§8)

![](shots/l01-library-600.jpg) At 600px high: "SWIPE TO SHUFFLE. TAP TO OPEN." sits above the Feed/Library switch.
The tooltip is checked at 600, 667 and 812px (375 wide) and 1280x700: it sits
below the dots, never over the card footer.

## One look with the waitlist and the sales intro

| | |
|---|---|
| ![](shots/v00-side-by-side-1280.jpg) 1280px: waitlist, sales intro, portal login. Same headline, pill input, eyebrow and the shared desk layer. | ![](shots/v00-side-by-side-390.jpg) 390px. |
| ![](shots/e01-caught-up-desk-390.jpg) Caught up, desk layer behind it, clear of the paper card and bubbles. | ![](shots/e02-empty-library-390.jpg) Empty Library: "Nothing on the *shelf* yet." |
| ![](shots/e03-empty-hub.jpg) Empty unlocked Hub: grid and one line, no desk. | ![](shots/m11a-log.jpg) The Log: "{n} calls logged.", my stamp, MATCH / SPLIT / TIMING, sources. |

The desk layer is `/shared/desk.js` at density "light", shown only on the
login, the caught-up Feed and an empty Library. Any fragment that would touch
text, a card, a bubble or a button is hidden (visibility only); checked at
360, 390, 768, 1280 and 1920px with zero layout shift.

Lighthouse, signed-in Feed included: `node tests/portal/lighthouse-serve.mjs`
serves the site with Supabase mocked, then point Lighthouse at
`/portal#access_token=tok-vedika&...`.
