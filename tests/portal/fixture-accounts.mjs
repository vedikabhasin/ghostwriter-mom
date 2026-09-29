// Call-mode accounts, besides Vedika (internal):
//   acmeDb()                    opened on the call: a 30-day window
//                               (portal_access_until), 5 sales-page swipes
//                               claimed by the owner, the free pick writing,
//                               one delivered piece. Hub locked (no credits).
//   acmeDb({ expired: true })   the same after the window closed
//   acmeDb({ credits: true })   a manual credit grant: the Hub opens, and no
//                               credit UI shows (CREDITS_ENABLED is false)
//   rprDb()                     RPR as it is on the live project: the 10
//                               cards, canceled with no window (so closed),
//                               seat_limit 4 with one temporary test seat.
// Gating is on account state only; nothing here keys on ids or names.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const localDay = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400e3);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

export const ACCOUNT_USERS = {
  'tok-acme':   { id: 'a0000000-0000-0000-0000-00000000000a', email: 'dana@acme.co' },
  'tok-acme2':  { id: 'a0000000-0000-0000-0000-00000000000b', email: 'lee@acme.co' },
  'tok-rpr':    { id: 'b0000000-0000-0000-0000-00000000000a', email: 'vedikabhasinwork@gmail.com' },
};
export const ACME_OWNER = 'a1000000-0000-0000-0000-000000000001';

const ACME_CARDS = [
  ['ac-01', 'pillar',  'Robots That Ask Before They Move'],
  ['ac-02', 'insight', 'Why Warehouse Pilots Stall at Week Six'],
  ['ac-03', 'post',    'The One Sensor We Keep Cutting'],
  ['ac-04', 'insight', 'Uptime Is a Staffing Problem'],
  ['ac-05', 'post',    'What Our Night Shift Taught the Arm'],
];
const ACME_NEXT = [
  ['ac-06', 'insight', 'Next week one'], ['ac-07', 'post', 'Next week two'], ['ac-08', 'pillar', 'Next week three'],
  ['ac-09', 'post', 'Next week four'], ['ac-10', 'insight', 'Next week five'],
];

export function acmeDb({ credits = false, expired = false } = {}) {
  const CO = 'a2000000-0000-0000-0000-000000000001';
  const t = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  const card = ([key, format, title], i, drop) => ({
    id: 'a3000000-0000-0000-0000-0000000000' + String(i).padStart(2, '0'), company_id: CO, card_key: key, format, series: null, title,
    angle: 'Short angle for ' + title.toLowerCase() + '.', evidence: 'Proof point for ' + key + '.', tags: ['ops'],
    sources: [{ title: 'Source A', publisher: 'Acme', url: 'https://acme.example/a' }, { title: 'Source B', publisher: 'Trade Weekly', url: 'https://trade.example/b' }],
    drop_date: drop, sort_order: i,
  });
  const cards = [...ACME_CARDS.map((c, i) => card(c, i, localDay(-2))), ...ACME_NEXT.map((c, i) => card(c, i + 10, localDay(9)))];
  const members = [
    { id: ACME_OWNER, company_id: CO, user_id: ACCOUNT_USERS['tok-acme'].id, role: 'owner', display_name: 'Dana', avatar_shape: 'blob', onboarding: {}, created_at: t(-200), email: 'dana@acme.co' },
    { id: 'a1000000-0000-0000-0000-000000000002', company_id: CO, user_id: ACCOUNT_USERS['tok-acme2'].id, role: 'member', display_name: 'Lee', avatar_shape: 'curl', onboarding: {}, created_at: t(-150), email: 'lee@acme.co' },
  ];
  // The prospect's 5 sales-page swipes, claimed by the owner on the call.
  const swipes = [['ac-01', 'like'], ['ac-02', 'fasttrack'], ['ac-03', 'pass'], ['ac-04', 'like'], ['ac-05', 'save']];
  const decisions = swipes.map(([k, a], i) => ({ id: 'ad' + i, company_id: CO, card_id: cards[i].id, member_id: ACME_OWNER, action: a, updated_at: t(-60 + i) }));
  const art = (i, status, extra) => ({ id: 'a4000000-0000-0000-0000-00000000000' + i, company_id: CO, card_id: cards[i].id, format: cards[i].format, title: cards[i].title,
    status, body_html: status === 'delivered' ? '<p>Delivered body.</p>' : null, google_doc_url: null, requested_at: null, requested_by: null, deliver_by: null, delivered_at: null, live_at: null, created_at: t(-100 + i), ...(extra || {}) });
  return {
    companies: [{ id: CO, slug: 'acme-q1w2e3', name: 'Acme Robotics', contact_first_name: 'Dana', is_internal: false,
      subscription_status: 'none', subscription_ends_at: null, hub_unlocked: false, stripe_subscription_id: null, plan_subscription_id: null,
      unlock_mode: 'call', portal_access_until: expired ? t(-24) : t(24 * 20), seat_limit: 3,
      first_opened_at: '2026-09-22T15:00:00Z', created_at: '2026-09-21T15:00:00Z' }],
    members,
    cards,
    decisions,
    swipe_events: decisions.map((d, i) => ({ id: 500 + i, company_id: CO, card_id: d.card_id, member_id: ACME_OWNER, action: d.action, source: 'sales', created_at: d.updated_at })),
    signals: [], notes: [], hub_items: [],
    articles: [
      // An earlier piece, not tied to one of these cards.
      art(0, 'delivered', { card_id: null, title: 'Night Shift Numbers, Explained', requested_at: t(-60), delivered_at: t(-41) }),
      art(1, 'writing', { requested_at: t(-4), deliver_by: t(20) }),
    ],
    credit_ledger: credits ? [
      { id: 'g-manual', company_id: CO, delta: 5, kind: 'grant', product: 'manual', grant_id: null, source_id: 'by_hand', expires_at: null, created_at: t(-120) },
    ] : [],
    pieces: [],
  };
}

export function rprDb() {
  const feed = JSON.parse(fs.readFileSync(path.join(ROOT, 'clients/rpr-k7m2qx.json'), 'utf8'));
  const CO = 'b2000000-0000-0000-0000-000000000001';
  const drops = ['2026-09-14', '2026-09-14', '2026-09-14', '2026-09-14', '2026-09-14', '2026-09-21', '2026-09-21', '2026-09-21', '2026-09-21', '2026-09-21'];
  return {
    companies: [{ id: CO, slug: 'rpr-k7m2qx', name: 'Rock Paper Reality', contact_first_name: 'Patrick', is_internal: false,
      subscription_status: 'canceled', subscription_ends_at: '2026-10-25T20:38:34+00:00', hub_unlocked: false,
      stripe_subscription_id: 'sub_1UJftBH0XOK4lyYe2EXA6g9r', plan_subscription_id: null, seat_limit: 4,
      unlock_mode: 'call', portal_access_until: null,
      first_opened_at: '2026-09-25T18:56:44.314023+00:00', created_at: '2026-09-25T18:56:44.314023+00:00' }],
    members: [
      { id: 'b1000000-0000-0000-0000-000000000002', company_id: CO, user_id: ACCOUNT_USERS['tok-rpr'].id, role: 'member', display_name: 'vedikabhasinwork', avatar_shape: 'blob', onboarding: {}, created_at: '2026-09-25T20:05:00Z' },
    ],
    cards: feed.cards.map((c, i) => ({ id: 'b3000000-0000-0000-0000-0000000000' + String(i).padStart(2, '0'), company_id: CO, card_key: c.id, format: c.format, series: null,
      title: c.title, angle: c.angle, evidence: c.evidence, tags: c.tags || [], sources: c.sources || [], drop_date: drops[i], sort_order: i })),
    decisions: [], swipe_events: [], signals: [], notes: [], hub_items: [], articles: [], credit_ledger: [], pieces: [],
  };
}
