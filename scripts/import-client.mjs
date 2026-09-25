#!/usr/bin/env node
// -----------------------------------------------------------------------------
// scripts/import-client.mjs
// Usage:  node scripts/import-client.mjs clients/<slug>.json
//
// Reads a client JSON in the existing shape (see clients/rpr-k7m2qx.json) and
// upserts a company + its cards + latest signal into Supabase via the service
// role key. Idempotent — safe to re-run whenever the JSON changes.
//
// Env:
//   SUPABASE_URL                the project URL (https://xxx.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY   service role key (server-side only, never
//                                bundle in the browser)
// -----------------------------------------------------------------------------
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

function die(msg) { console.error(msg); process.exit(1); }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  die("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.");
}

const [, , fileArg] = process.argv;
if (!fileArg) die("usage: node scripts/import-client.mjs clients/<slug>.json");

const filePath = path.resolve(process.cwd(), fileArg);
if (!fs.existsSync(filePath)) die(`file not found: ${filePath}`);

const raw = fs.readFileSync(filePath, "utf8");
let data;
try { data = JSON.parse(raw); } catch (err) { die(`invalid JSON: ${err.message}`); }

const {
  slug, companyName, contactFirstName, emailKnown,
  directionShape, offerText, signal, cards
} = data;

if (!slug)          die("client JSON missing 'slug'");
if (!companyName)   die("client JSON missing 'companyName'");
if (!Array.isArray(cards) || !cards.length) die("client JSON missing non-empty 'cards'");

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function upsertCompany() {
  const payload = {
    slug,
    name: companyName,
    contact_first_name: contactFirstName ?? null,
    email_known: !!emailKnown,
    direction_shape: directionShape ?? {},
    offer_text: offerText ?? null,
  };
  // Try update first; if no row, insert.
  const { data: existing, error: selErr } = await supabase
    .from("companies").select("id").eq("slug", slug).maybeSingle();
  if (selErr) throw selErr;
  if (existing) {
    const { error } = await supabase
      .from("companies").update(payload).eq("id", existing.id);
    if (error) throw error;
    return existing.id;
  }
  const { data: inserted, error } = await supabase
    .from("companies").insert(payload).select("id").single();
  if (error) throw error;
  return inserted.id;
}

async function upsertCards(companyId) {
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
    sort_order: order++,
  }));
  const { error } = await supabase
    .from("cards")
    .upsert(rows, { onConflict: "company_id,card_key" });
  if (error) throw error;
  return rows.length;
}

async function upsertSignal(companyId) {
  if (!signal) return 0;
  // Signals are an append-only log elsewhere, but for the client-JSON path we
  // treat the file as the canonical source: replace any existing rows for
  // this company with the one from the file.
  const { error: delErr } = await supabase
    .from("signals").delete().eq("company_id", companyId);
  if (delErr) throw delErr;
  const { error } = await supabase.from("signals").insert({
    company_id: companyId,
    text:       signal.text,
    source:     signal.source,
    signal_date: signal.date,
  });
  if (error) throw error;
  return 1;
}

(async () => {
  try {
    const companyId = await upsertCompany();
    const cardCount = await upsertCards(companyId);
    const sigCount  = await upsertSignal(companyId);
    console.log(`✓ imported ${slug} — company ${companyId}, ${cardCount} cards, ${sigCount} signal(s)`);
  } catch (err) {
    console.error("import failed:", err?.message ?? err);
    process.exit(1);
  }
})();
