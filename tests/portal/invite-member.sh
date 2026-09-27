#!/usr/bin/env bash
# Runs supabase/functions/invite-member under Deno against a local mock of
# Supabase Auth + PostgREST and exercises each check.
#   npx --yes deno --version   # once, if deno isn't installed
#   bash tests/portal/invite-member.sh
set -u
if curl -s -o /dev/null http://127.0.0.1:8000; then echo "port 8000 is busy; stop whatever is on it first"; exit 2; fi
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$HERE/../.."
DENO="${DENO:-$(command -v deno || echo 'npx --yes deno')}"
node "$HERE/invite-member-mock.mjs" > /dev/null 2>&1 & MOCK=$!
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=service DENO_NO_UPDATE_CHECK=1 \
  $DENO run --node-modules-dir=none --allow-net --allow-env --allow-read --allow-sys \
  "$ROOT/supabase/functions/invite-member/index.ts" > /dev/null 2>&1 & FN=$!
trap 'kill $FN $MOCK 2>/dev/null' EXIT
for i in $(seq 1 90); do curl -s -o /dev/null http://127.0.0.1:54321/__state && curl -s -o /dev/null http://127.0.0.1:8000 && break; sleep 1; done
fail=0
expect() { # name token body expected-status expected-substring
  out=$(curl -s -w ' %{http_code}' -X POST http://127.0.0.1:8000 -H "Authorization: Bearer $2" -H 'content-type: application/json' -d "$3")
  if [[ "$out" == *" $4" && "$out" == *"$5"* ]]; then echo "ok   $1"; else echo "FAIL $1: $out"; fail=1; fi
}
expect no_token        ""      '{"emails":["a@b.co"]}'                  401 not_signed_in
expect not_a_member    tok-out '{"emails":["a@b.co"]}'                  403 not_a_member
expect invalid_email   tok-sam '{"emails":["not-an-email"]}'            400 invalid_email
expect self_invite     tok-sam '{"emails":["sam@x.com"]}'               400 self_invite
expect too_many        tok-sam '{"emails":["a@b.co","b@b.co","c@b.co"]}' 400 too_many
expect seat_limit      tok-sam '{"emails":["new1@b.co","new2@b.co"]}'   409 '"seats_left":1'
expect invite_ok       tok-sam '{"emails":["New1@B.co"]}'               200 '"status":"invited"'
expect now_full        tok-sam '{"emails":["new3@b.co"]}'               409 '"seats_left":0'
# Company c2 (one member): existing accounts, repeats, and a mailer outage.
expect existing_gets_link tok-two '{"emails":["existing@x.com"]}'        200 '"status":"invited"'
expect already_member     tok-two '{"emails":["existing@x.com"]}'        409 '"error":"already_member"'
curl -s -X POST http://127.0.0.1:54321/__mail -d '{"down":true}' > /dev/null
expect mail_down          tok-two '{"emails":["existing2@x.com"]}'       502 '"error":"failed"'
curl -s -X POST http://127.0.0.1:54321/__mail -d '{"down":false}' > /dev/null
state=$(curl -s http://127.0.0.1:54321/__state)
if [[ "$state" == *'"otps":[{"email":"existing@x.com","create_user":false,"redirect":"https://www.ghostwriter.mom/portal"}]'* ]]; then
  echo "ok   existing account: one sign-in link, no new user"; else echo "FAIL existing account link: $state"; fail=1; fi
if [[ "$state" == *'"company_id":"c2","user_id":"u-exist2"'* ]]; then
  echo "ok   mail down: seat row kept, reported as failed"; else echo "FAIL mail down row: $state"; fail=1; fi
if [[ "$state" == *'"user_id":"u-new1","role":"member","display_name":"New1"'* && "$state" == *'"redirect":"https://www.ghostwriter.mom/portal"'* ]]; then
  echo "ok   members row + invite redirect"; else echo "FAIL members row: $state"; fail=1; fi
exit $fail
