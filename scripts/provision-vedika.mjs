#!/usr/bin/env node
// -----------------------------------------------------------------------------
// scripts/provision-vedika.mjs
// One-shot provisioner for Vedika Bhasin's internal portal.
// Idempotent: rerunning skips existing users, company, cards, articles, hub
// items, and decisions instead of duplicating them. Prints the final slug.
//
// What it does:
//   1. Generate a stable slug of the form "vedika-bhasin-<6char>" (only if the
//      file still holds the placeholder "vedika-bhasin"). Writes it back into
//      clients/vedika-bhasin.json.
//   2. Upsert the company (is_internal=true, subscription_status='active',
//      hub_unlocked=true).
//   3. Ensure auth users exist for owner (vedikabhasin@gmail.com) and test
//      member (blendbases@gmail.com). Uses admin.createUser with
//      email_confirm=true so no invite mail goes out. If a user already
//      belongs to a member row on another company, leaves it alone and prints
//      a warning.
//   4. Ensure both members rows exist (owner + member), with two different
//      avatar_shape values so their monsters don't clash.
//   5. Upsert the 17 cards from clients/vedika-bhasin.json (via the same
//      import-client logic) with correct sort_order.
//   6. Seed the signal (delete-then-insert).
//   7. Seed three articles (vb-01 delivered with body_html; vb-05 approved
//      with requested_at + deliver_by; bx-01 approved with no timestamps).
//      For vb-01, if RPR has a delivered article, its body_html is copied.
//      Otherwise a placeholder body with two H2s is used.
//   8. Seed two hub_items text notes, top-left of the canvas.
//   9. Seed the test member's decisions (vb-02 like, vb-03 pass, vb-04 like).
//
// Env:
//   SUPABASE_URL                the project URL
//   SUPABASE_SERVICE_ROLE_KEY   service role key (server-side only)
// -----------------------------------------------------------------------------
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function die(msg) { console.error(msg); process.exit(1); }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  die("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.");
}

const JSON_PATH = path.resolve(process.cwd(), "clients/vedika-bhasin.json");
if (!fs.existsSync(JSON_PATH)) die(`file not found: ${JSON_PATH}`);

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const OWNER_EMAIL  = "vedikabhasin@gmail.com";
const MEMBER_EMAIL = "blendbases@gmail.com";
const OWNER_AVATAR  = "worm";
const MEMBER_AVATAR = "spike";

const VB_01_BODY_FALLBACK = `
<h2>Where judgment lives</h2>
<p>The interesting work in AI-assisted design starts at the exact moment the model is wrong. Everything before that is templated; everything after is templated too. The judgment lives in the seam.</p>
<h2>Three wrong moments, three interfaces</h2>
<p>Civic Twin's approval gate refuses to publish until an operator signs off, because a wrong answer at the city level costs weeks. Brief Monster's Trap page lists the tempting move and why it's the wrong one, so the AI's confident second choice never becomes the plan. Existential Until I Met You captures the exact frames where object detection is unsure — that's the piece.</p>
<p>The manifesto: the model produces ideas. You produce refusals. The product is the shape of your refusal.</p>
`.trim();

function loadJson() { return JSON.parse(fs.readFileSync(JSON_PATH, "utf8")); }
function writeJson(data) { fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2) + "\n", "utf8"); }

function ensureSlug(json) {
  // Idempotent: if the slug is anything but the placeholder, keep it.
  if (json.slug && json.slug !== "vedika-bhasin" && json.slug !== "vedika-bhasin-GENERATE") {
    return json.slug;
  }
  const suffix = crypto.randomBytes(4).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
  const slug = `vedika-bhasin-${suffix}`;
  json.slug = slug;
  writeJson(json);
  return slug;
}

async function upsertCompany(json) {
  const payload = {
    slug: json.slug,
    name: json.companyName,
    contact_first_name: json.contactFirstName ?? "Vedika",
    is_internal: true,
    subscription_status: "active",
    subscription_ends_at: null,
    hub_unlocked: true,
    direction_shape: {},
    email_known: true,
    offer_text: null,
  };
  const { data: existing, error: selErr } = await supabase
    .from("companies").select("id").eq("slug", json.slug).maybeSingle();
  if (selErr) throw selErr;
  if (existing) {
    const { error } = await supabase.from("companies").update(payload).eq("id", existing.id);
    if (error) throw error;
    return existing.id;
  }
  const { data: inserted, error } = await supabase
    .from("companies").insert(payload).select("id").single();
  if (error) throw error;
  return inserted.id;
}

async function findAuthUserId(email) {
  const perPage = 200;
  for (let page = 1; page <= 25; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const hit = data.users.find(u => (u.email ?? "").toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < perPage) break;
  }
  return null;
}

async function ensureAuthUser(email) {
  const existing = await findAuthUserId(email);
  if (existing) return { id: existing, created: false };
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error) throw new Error(`create user ${email}: ${error.message}`);
  return { id: data.user.id, created: true };
}

async function ensureMember(companyId, userId, role, avatarShape, email) {
  // Warn if the user is already a member of another company — leave that
  // membership alone.
  const { data: others, error: selErr } = await supabase
    .from("members")
    .select("id, company_id, role, companies:companies(slug,name)")
    .eq("user_id", userId);
  if (selErr) throw selErr;
  const otherMemberships = (others ?? []).filter(m => m.company_id !== companyId);
  if (otherMemberships.length) {
    for (const m of otherMemberships) {
      const sl = m.companies?.slug ?? m.company_id;
      console.warn(`  ! ${email} is already a ${m.role} of company ${sl}. leaving that membership alone.`);
    }
  }

  const here = (others ?? []).find(m => m.company_id === companyId);
  if (here) {
    // Ensure role + avatar_shape stay in sync (idempotent).
    if (here.role !== role || !here.avatar_shape) {
      const { error } = await supabase.from("members")
        .update({ role, avatar_shape: avatarShape })
        .eq("id", here.id);
      if (error) throw error;
    }
    return here.id;
  }
  const { data: inserted, error } = await supabase.from("members").insert({
    company_id:   companyId,
    user_id:      userId,
    role,
    avatar_shape: avatarShape,
    display_name: email.split("@")[0],
  }).select("id").single();
  if (error) throw new Error(`insert member ${email}: ${error.message}`);
  return inserted.id;
}

async function upsertCards(companyId, cards) {
  let order = 0;
  const rows = cards.map(c => ({
    company_id: companyId,
    card_key:   c.id,
    format:     c.format,
    title:      c.title,
    angle:      c.angle,
    evidence:   c.evidence,
    tags:       Array.isArray(c.tags) ? c.tags : [],
    sources:    c.sources ?? [],
    series:     c.series ?? null,
    sort_order: order++,
  }));
  const { error } = await supabase.from("cards")
    .upsert(rows, { onConflict: "company_id,card_key" });
  if (error) throw error;
  // Prune any rows for this company whose card_key isn't in the JSON.
  const kept = rows.map(r => r.card_key);
  const { error: pruneErr } = await supabase.from("cards")
    .delete()
    .eq("company_id", companyId)
    .not("card_key", "in", `(${kept.map(k => `"${k.replace(/"/g, '""')}"`).join(",")})`);
  if (pruneErr) throw pruneErr;
  return rows.length;
}

async function upsertSignal(companyId, signal) {
  if (!signal) return 0;
  const { error: delErr } = await supabase.from("signals").delete().eq("company_id", companyId);
  if (delErr) throw delErr;
  const { error } = await supabase.from("signals").insert({
    company_id:  companyId,
    text:        signal.text,
    source:      signal.source,
    signal_date: signal.date,
  });
  if (error) throw error;
  return 1;
}

async function cardIdByKey(companyId, cardKey) {
  const { data, error } = await supabase
    .from("cards").select("id").eq("company_id", companyId).eq("card_key", cardKey).maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

async function findRprDeliveredBody() {
  const { data: rpr, error: e1 } = await supabase
    .from("companies").select("id").eq("slug", "rpr-k7m2qx").maybeSingle();
  if (e1) throw e1;
  if (!rpr) return null;
  const { data: art, error: e2 } = await supabase
    .from("articles")
    .select("body_html")
    .eq("company_id", rpr.id)
    .eq("status", "delivered")
    .not("body_html", "is", null)
    .limit(1);
  if (e2) throw e2;
  return (art?.[0]?.body_html) ?? null;
}

async function seedArticle(companyId, cardKey, patch) {
  const cardId = await cardIdByKey(companyId, cardKey);
  if (!cardId) throw new Error(`unknown card_key ${cardKey}`);
  const { data: existing, error: selErr } = await supabase
    .from("articles").select("id").eq("company_id", companyId).eq("card_id", cardId).maybeSingle();
  if (selErr) throw selErr;
  if (existing) {
    const { error } = await supabase.from("articles").update(patch).eq("id", existing.id);
    if (error) throw error;
    return existing.id;
  }
  // Format + title are inferred from the card row for cleanliness.
  const { data: card, error: cErr } = await supabase
    .from("cards").select("format, title").eq("id", cardId).single();
  if (cErr) throw cErr;
  const insertPayload = {
    company_id: companyId,
    card_id:    cardId,
    format:     card.format,
    title:      card.title,
    ...patch,
  };
  const { data: inserted, error } = await supabase.from("articles").insert(insertPayload).select("id").single();
  if (error) throw error;
  return inserted.id;
}

async function seedHubTextItem(companyId, body, x, y, z) {
  const { data: existing, error: selErr } = await supabase
    .from("hub_items")
    .select("id")
    .eq("company_id", companyId)
    .eq("kind", "text")
    .eq("body", body)
    .limit(1);
  if (selErr) throw selErr;
  if (existing && existing.length) return existing[0].id;
  const { data: inserted, error } = await supabase.from("hub_items").insert({
    company_id: companyId,
    kind:       "text",
    body,
    x, y, z,
    rotation:   0,
    created_by: null,
  }).select("id").single();
  if (error) throw error;
  return inserted.id;
}

async function seedMemberDecision(companyId, memberId, cardKey, action) {
  const cardId = await cardIdByKey(companyId, cardKey);
  if (!cardId) throw new Error(`unknown card_key ${cardKey}`);
  // Idempotent: only insert a decision + swipe_event if no decision exists
  // for this (company, card, member).
  const { data: existing, error: selErr } = await supabase
    .from("decisions").select("id, action")
    .eq("company_id", companyId).eq("card_id", cardId).eq("member_id", memberId).maybeSingle();
  if (selErr) throw selErr;
  if (existing) {
    // Ensure action matches; if not, update + append a fresh swipe_event.
    if (existing.action === action) return existing.id;
    const { error: uErr } = await supabase.from("decisions")
      .update({ action, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (uErr) throw uErr;
  } else {
    const { error: dErr } = await supabase.from("decisions").insert({
      company_id: companyId, card_id: cardId, member_id: memberId, action,
    });
    if (dErr) throw dErr;
  }
  const { error: eErr } = await supabase.from("swipe_events").insert({
    company_id: companyId, card_id: cardId, member_id: memberId, action, source: "portal",
  });
  if (eErr) throw eErr;
  return true;
}

(async () => {
  try {
    const json = loadJson();
    const slug = ensureSlug(json);
    console.log(`– slug: ${slug}`);

    const companyId = await upsertCompany(json);
    console.log(`✓ company upserted (${companyId})`);

    const owner  = await ensureAuthUser(OWNER_EMAIL);
    const member = await ensureAuthUser(MEMBER_EMAIL);
    console.log(`✓ auth users: owner=${owner.id}${owner.created ? " (created)" : ""}, member=${member.id}${member.created ? " (created)" : ""}`);

    const ownerMemberId  = await ensureMember(companyId, owner.id,  "owner",  OWNER_AVATAR,  OWNER_EMAIL);
    const memberMemberId = await ensureMember(companyId, member.id, "member", MEMBER_AVATAR, MEMBER_EMAIL);
    console.log(`✓ members: owner=${ownerMemberId}, member=${memberMemberId}`);

    const cardCount = await upsertCards(companyId, json.cards);
    console.log(`✓ cards: ${cardCount} rows (VB + BlendXR interleaved)`);

    const sigCount = await upsertSignal(companyId, json.signal);
    console.log(`✓ signal: ${sigCount}`);

    // ---- articles -------------------------------------------------------
    const now = new Date();
    const iso = (d) => d.toISOString();
    const vb01Body = (await findRprDeliveredBody()) ?? VB_01_BODY_FALLBACK;
    const vb01RequestedAt = iso(new Date(now.getTime() - 43 * 3600 * 1000));
    const vb01DeliveredAt = iso(new Date(now.getTime() - 24 * 3600 * 1000));
    await seedArticle(companyId, "vb-01", {
      status:        "delivered",
      body_html:     vb01Body,
      requested_at:  vb01RequestedAt,
      delivered_at:  vb01DeliveredAt,
      deliver_by:    null,
    });
    await seedArticle(companyId, "vb-05", {
      status:        "approved_unwritten",
      requested_at:  iso(now),
      deliver_by:    iso(new Date(now.getTime() + 24 * 3600 * 1000)),
      body_html:     null,
      delivered_at:  null,
    });
    await seedArticle(companyId, "bx-01", {
      status:        "approved_unwritten",
      requested_at:  null,
      deliver_by:    null,
      body_html:     null,
      delivered_at:  null,
    });
    console.log("✓ articles: vb-01 delivered, vb-05 approved (countdown), bx-01 approved (no request)");

    // ---- hub items ------------------------------------------------------
    await seedHubTextItem(
      companyId,
      "Rules for every post: Hook in the first two lines, then the turn, then my work as proof, then a closing line plus an open question. Document carousels over video. Links in the first comment, never the body. No hashtags. Post Tue to Thu, 8 to 10 AM ET, reply in the first hour. Real visuals only, no AI renders. BlendXR shows concept and prototype work only, clients anonymized.",
      24, 24, 2
    );
    await seedHubTextItem(
      companyId,
      "Cadence: VB weekly, starting after the Civic Twin posts on Sep 28 and Oct 5. BlendXR every 3 weeks. Credit team work as team work. Client clips (VB 6, 7, 8) only from what is already public in the AR reel.",
      24, 220, 1
    );
    console.log("✓ hub_items: 2 text notes seeded top-left");

    // ---- test member decisions -----------------------------------------
    await seedMemberDecision(companyId, memberMemberId, "vb-02", "like");
    await seedMemberDecision(companyId, memberMemberId, "vb-03", "pass");
    await seedMemberDecision(companyId, memberMemberId, "vb-04", "like");
    console.log("✓ test member decisions: vb-02 like, vb-03 pass, vb-04 like");

    console.log(`\n✓ provisioned. slug = ${slug}`);
    console.log(`  visit https://ghostwriter.mom/${slug} to enter (redirects to /portal for internals).`);
  } catch (err) {
    console.error("provision failed:", err?.message ?? err);
    process.exit(1);
  }
})();
