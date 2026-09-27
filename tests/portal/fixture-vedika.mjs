// The Vedika Bhasin internal portal as provisioned on the live project
// (Session A's provision-vedika.mjs, Sep 27 2026): real ids, cards from
// clients/vedika-bhasin.json, all dropping Sep 27. Times are relative to
// "now" so the delivery stamp and the countdown read like production.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const JSON_FEED = JSON.parse(fs.readFileSync(path.join(ROOT, 'clients/vedika-bhasin.json'), 'utf8'));
const CO = 'b22beda7-45cf-486a-931e-d3b429619788';
export const OWNER = '9afe9458-e205-4209-96ec-9c8f6fab77c5';
export const MEMBER = 'f3d05fe1-aca2-42f6-9b1f-a65a9df90f5b';
export const USERS = {
  'tok-vedika': { id: '61622a22-24de-4165-87e7-2b2b188f6782', email: 'vedikabhasin@gmail.com' },
  'tok-blend':  { id: '19ca6304-ea70-4261-bdf8-c0e702b56e0b', email: 'blendbases@gmail.com' },
  'tok-client': { id: '0b7e5a52-2f1c-4c8e-9a61-7f0a1c2b3d02', email: 'client@example.com' },
};
const CARD_IDS = {"bx-01":"97bc24f3-fd2b-44fa-a022-937ca6000dfd","bx-02":"04d9e2c9-9425-4f3e-91db-47ad432ba659","bx-03":"0cdf2116-d721-4943-8144-122be052453b","bx-04":"6a65fd25-fe27-450b-b396-fbfdcded4175","bx-05":"c5394b3d-28d5-4af8-a543-369d29a958bd","vb-01":"010e1d9d-68bb-49cc-a13b-d766f96ef5f3","vb-02":"3d3b288d-6792-4168-ae25-ccc5e66760ce","vb-03":"c1b7cb8e-d1c0-45f8-9517-b338338282e6","vb-04":"c2975be9-dfa9-4215-a215-9fa21087b1ea","vb-05":"f31741ed-f37e-4b95-b3c1-5331cf811869","vb-06":"838e0b01-8a12-4284-881e-914cb9b84110","vb-07":"440469ae-596d-4e35-ae5b-773217bcda75","vb-08":"7df897c6-69a2-4298-b2e8-f6f40f6491bb","vb-09":"6b05cd2b-7108-4e0c-965f-1a94f1663de2","vb-10":"8aca24df-fc0c-4a70-a550-50de75f4b5f2","vb-11":"f9143fab-aff2-43ed-a282-2960bde5c00b","vb-12":"add6571e-46ab-4ca8-a7e2-f860c59c8448"};
export const cardId = (key) => CARD_IDS[key];
const RULES = 'Rules for every post: Hook in the first two lines, then the turn, then my work as proof, then a closing line plus an open question. Document carousels over video. Links in the first comment, never the body. No hashtags. Post Tue to Thu, 8 to 10 AM ET, reply in the first hour. Real visuals only, no AI renders. BlendXR shows concept and prototype work only, clients anonymized.';
const CADENCE = 'Cadence: VB weekly, starting after the Civic Twin posts on Sep 28 and Oct 5. BlendXR every 3 weeks. Credit team work as team work. Client clips (VB 6, 7, 8) only from what is already public in the AR reel.';
const VB01_BODY = `<h2>Where judgment lives</h2>
<p>The interesting work in AI-assisted design starts at the exact moment the model is wrong. Everything before that is templated; everything after is templated too. The judgment lives in the seam.</p>
<h2>Three wrong moments, three interfaces</h2>
<p>Civic Twin's approval gate refuses to publish until an operator signs off, because a wrong answer at the city level costs weeks. Brief Monster's Trap page lists the tempting move and why it's the wrong one, so the AI's confident second choice never becomes the plan. Existential Until I Met You captures the exact frames where object detection is unsure — that's the piece.</p>
<p>The manifesto: the model produces ideas. You produce refusals. The product is the shape of your refusal.</p>`;

export function vedikaDb(overrides = {}) {
  const now = Date.now();
  const iso = (ms) => new Date(now + ms).toISOString();
  const H = 3600e3;
  const members = [
    { id: OWNER,  company_id: CO, user_id: USERS['tok-vedika'].id, role: 'owner',  display_name: 'vedikabhasin', avatar_shape: 'worm',  onboarding: {}, created_at: '2026-09-27T18:47:47.473518+00:00' },
    { id: MEMBER, company_id: CO, user_id: USERS['tok-blend'].id,  role: 'member', display_name: 'blendbases',   avatar_shape: 'spike', onboarding: {}, created_at: '2026-09-27T18:47:47.473519+00:00' },
  ];
  const decisions = [['vb-02', 'like'], ['vb-03', 'pass'], ['vb-04', 'like']]
    .map(([k, a], i) => ({ id: 'd' + i, company_id: CO, card_id: cardId(k), member_id: MEMBER, action: a, updated_at: iso(-2 * H) }));
  return {
    companies: [{ id: CO, slug: 'vedika-bhasin-ycfogw', name: 'Vedika Bhasin', contact_first_name: 'Vedika', is_internal: true,
      subscription_status: 'active', subscription_ends_at: null, hub_unlocked: true, stripe_subscription_id: null, plan_subscription_id: null,
      first_opened_at: '2026-09-27T18:47:47.473518+00:00', created_at: '2026-09-27T18:47:47.473518+00:00', ...(overrides.company || {}) }],
    members,
    cards: JSON_FEED.cards.map((c, i) => ({ id: cardId(c.id), company_id: CO, card_key: c.id, format: c.format, series: c.series, title: c.title,
      angle: c.angle, evidence: c.evidence, tags: c.tags || [], sources: c.sources || [], drop_date: '2026-09-27', sort_order: i })),
    decisions,
    swipe_events: decisions.map((d, i) => ({ id: 100 + i, company_id: CO, card_id: d.card_id, member_id: MEMBER, action: d.action, source: 'portal', created_at: iso(-2 * H + i * 60e3) })),
    signals: [{ id: 'fc9ad5b6-0c18-4cb9-8b19-a406d3d6f34b', company_id: CO, text: JSON_FEED.signal.text, source: JSON_FEED.signal.source, signal_date: JSON_FEED.signal.date, created_at: iso(-3 * H) }],
    articles: [
      { id: '553f5a86-290e-4a13-ad97-3e7fa29e6c5f', company_id: CO, card_id: cardId('vb-01'), format: 'post', title: 'I Design for the Moment AI Is Wrong', status: 'delivered',
        body_html: VB01_BODY, google_doc_url: null, requested_at: iso(-43 * H), deliver_by: null, delivered_at: iso(-24 * H), live_at: null, created_at: iso(-43 * H) },
      { id: 'd4579ee5-34dc-4065-b21d-97013b252f02', company_id: CO, card_id: cardId('vb-05'), format: 'post', title: 'The Most Useful Page Says What Not to Do', status: 'approved_unwritten',
        body_html: null, google_doc_url: null, requested_at: iso(-9.6 * H), deliver_by: iso(14.3 * H), delivered_at: null, live_at: null, created_at: iso(-9.6 * H) },
      { id: '8add2b56-951c-460c-a674-27bee47f4954', company_id: CO, card_id: cardId('bx-01'), format: 'post', title: 'The Experienced Eyes Are Retiring', status: 'approved_unwritten',
        body_html: null, google_doc_url: null, requested_at: null, deliver_by: null, delivered_at: null, live_at: null, created_at: iso(-3 * H) },
    ],
    notes: [],
    credit_ledger: [],
    pieces: [],
    hub_items: [
      { id: '31e4f1d2-dc70-4701-999b-8cbb2f5dd1bc', company_id: CO, kind: 'text', ref_id: null, body: RULES,   emoji: null, x: 24, y: 24,  rotation: 0, z: 2, hidden: false, created_by: null, updated_at: iso(-3 * H) },
      { id: 'e49f6c62-af3d-438d-8ee8-7adb49e6657f', company_id: CO, kind: 'text', ref_id: null, body: CADENCE, emoji: null, x: 24, y: 220, rotation: 0, z: 1, hidden: false, created_by: null, updated_at: iso(-3 * H) },
    ],
  };
}
