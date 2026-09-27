// Accounts for the credits walkthrough, besides Vedika (internal):
//   acmeDb()                  a $19 portal, no credit purchase yet: Hub locked
//   acmeDb({ credits: true }) the same with a Starter pack and a plan month
//   rprDb()                   RPR as it is on the live project: the 10 cards
//                             from clients/rpr-k7m2qx.json, 2 seats, no
//                             decisions or articles, the $19 set to cancel
//                             (canceled, ends Oct 25) so it can be resumed.
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
  'tok-rpr':    { id: 'b0000000-0000-0000-0000-00000000000a', email: 'patrick@rockpaperreality.com' },
  'tok-rpr2':   { id: 'b0000000-0000-0000-0000-00000000000b', email: 'sam@rockpaperreality.com' },
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

export function acmeDb({ credits = false } = {}) {
  const CO = 'a2000000-0000-0000-0000-000000000001';
  const t = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  const card = ([key, format, title], i, drop) => ({
    id: 'a3000000-0000-0000-0000-0000000000' + String(i).padStart(2, '0'), company_id: CO, card_key: key, format, series: null, title,
    angle: 'Short angle for ' + title.toLowerCase() + '.', evidence: 'Proof point for ' + key + '.', tags: ['ops'],
    sources: [{ title: 'Source A', publisher: 'Acme', url: 'https://acme.example/a' }, { title: 'Source B', publisher: 'Trade Weekly', url: 'https://trade.example/b' }],
    drop_date: drop, sort_order: i,
  });
  const cards = [...ACME_CARDS.map((c, i) => card(c, i, localDay(0))), ...ACME_NEXT.map((c, i) => card(c, i + 10, localDay(9)))];
  const members = [
    { id: ACME_OWNER, company_id: CO, user_id: ACCOUNT_USERS['tok-acme'].id, role: 'owner', display_name: 'Dana', avatar_shape: 'blob', onboarding: {}, created_at: t(-200) },
  ];
  if (credits) members.push({ id: 'a1000000-0000-0000-0000-000000000002', company_id: CO, user_id: ACCOUNT_USERS['tok-acme2'].id, role: 'member', display_name: 'Lee', avatar_shape: 'curl', onboarding: {}, created_at: t(-150) });
  const art = (i, status, extra) => ({ id: 'a4000000-0000-0000-0000-00000000000' + i, company_id: CO, card_id: cards[i].id, format: cards[i].format, title: cards[i].title,
    status, body_html: status === 'delivered' ? '<p>Delivered body.</p>' : null, google_doc_url: null, requested_at: null, deliver_by: null, delivered_at: null, live_at: null, created_at: t(-100 + i), ...(extra || {}) });
  return {
    companies: [{ id: CO, slug: 'acme-q1w2e3', name: 'Acme Robotics', contact_first_name: 'Dana', is_internal: false,
      subscription_status: 'active', subscription_ends_at: null, hub_unlocked: false, stripe_subscription_id: 'sub_acme', plan_subscription_id: credits ? 'sub_acme_plan' : null,
      first_opened_at: '2026-09-22T15:00:00Z', created_at: '2026-09-21T15:00:00Z' }],
    members,
    cards,
    decisions: [], swipe_events: [], signals: [], notes: [], hub_items: [],
    articles: [
      art(0, 'delivered', { requested_at: t(-60), delivered_at: t(-41) }),
      art(1, 'approved_unwritten'),
      art(2, 'approved_unwritten'),
      art(3, 'approved_unwritten'),
    ],
    credit_ledger: credits ? [
      { id: 'g-starter', company_id: CO, delta: 5, kind: 'grant', product: 'starter', grant_id: null, source_id: 'cs_starter', expires_at: null, created_at: t(-120) },
      { id: 'g-plan', company_id: CO, delta: 20, kind: 'grant', product: 'plan', grant_id: null, source_id: 'in_plan1', expires_at: t(24 * 40), created_at: t(-100) },
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
      stripe_subscription_id: 'sub_1UJftBH0XOK4lyYe2EXA6g9r', plan_subscription_id: null,
      first_opened_at: '2026-09-25T18:56:44.314023+00:00', created_at: '2026-09-25T18:56:44.314023+00:00' }],
    members: [
      { id: 'b1000000-0000-0000-0000-000000000001', company_id: CO, user_id: ACCOUNT_USERS['tok-rpr'].id, role: 'owner', display_name: null, avatar_shape: 'ghost', onboarding: {}, created_at: '2026-09-25T20:00:00Z' },
      { id: 'b1000000-0000-0000-0000-000000000002', company_id: CO, user_id: ACCOUNT_USERS['tok-rpr2'].id, role: 'member', display_name: 'Sam', avatar_shape: 'blob', onboarding: {}, created_at: '2026-09-25T20:05:00Z' },
    ],
    cards: feed.cards.map((c, i) => ({ id: 'b3000000-0000-0000-0000-0000000000' + String(i).padStart(2, '0'), company_id: CO, card_key: c.id, format: c.format, series: null,
      title: c.title, angle: c.angle, evidence: c.evidence, tags: c.tags || [], sources: c.sources || [], drop_date: drops[i], sort_order: i })),
    decisions: [], swipe_events: [], signals: [], notes: [], hub_items: [], articles: [], credit_ledger: [], pieces: [],
  };
}
