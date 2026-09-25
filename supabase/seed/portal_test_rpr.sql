-- ---------------------------------------------------------------------------
-- Portal test fixture on RPR (rpr-k7m2qx). Re-runnable.
-- Creates two test members, sets drop dates, seeds decisions that produce an
-- Agree, a Split and a Timing overlap, and one delivered + two ghost articles.
-- Undo with portal_test_rpr_cleanup.sql.
--
--   owner   vedikabhasin+rpr-owner@gmail.com   shows as "Patrick" (contact_first_name)
--   member  vedikabhasinwork@gmail.com         display_name "Sam"
--
-- Run in the Supabase SQL editor (runs as postgres, bypasses RLS).
-- ---------------------------------------------------------------------------
do $$
declare
  v_company uuid := (select id from companies where slug = 'rpr-k7m2qx');
  v_owner_uid uuid := '0b7e5a52-2f1c-4c8e-9a61-7f0a1c2b3d01';
  v_sam_uid   uuid := '0b7e5a52-2f1c-4c8e-9a61-7f0a1c2b3d02';
  v_owner uuid; v_sam uuid;
  u record;
begin
  if v_company is null then raise exception 'rpr-k7m2qx not imported'; end if;

  -- Auth users (email-confirmed; they sign in with "Send me a link").
  for u in select * from (values
      (v_owner_uid, 'vedikabhasin+rpr-owner@gmail.com'),
      (v_sam_uid,   'vedikabhasinwork@gmail.com')) as t(id, email)
  loop
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change_token_new, email_change)
    values ('00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
            crypt(gen_random_uuid()::text, gen_salt('bf')), now(),
            '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
    on conflict (id) do nothing;
    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (u.id::text, u.id, jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
            'email', now(), now(), now())
    on conflict do nothing;
  end loop;

  insert into members (company_id, user_id, role, display_name, avatar_shape)
    values (v_company, v_owner_uid, 'owner', null, 'ghost')
    on conflict (company_id, user_id) do update set role = 'owner', avatar_shape = 'ghost', onboarding = '{}';
  insert into members (company_id, user_id, role, display_name, avatar_shape)
    values (v_company, v_sam_uid, 'member', 'Sam', 'blob')
    on conflict (company_id, user_id) do update set display_name = 'Sam', avatar_shape = 'blob', onboarding = '{}';
  select id into v_owner from members where company_id = v_company and user_id = v_owner_uid;
  select id into v_sam   from members where company_id = v_company and user_id = v_sam_uid;

  -- Two drops: rpr-01..05 last week, rpr-06..10 this week.
  update cards set drop_date = case when card_key <= 'rpr-05' then date '2026-09-14' else date '2026-09-21' end
   where company_id = v_company;

  -- Reset decisions / history / notes / articles for a clean walkthrough.
  delete from notes        where company_id = v_company;
  delete from swipe_events where company_id = v_company;
  delete from decisions    where company_id = v_company;
  delete from articles     where company_id = v_company;

  -- Patrick on the sales page (member_id null).
  insert into swipe_events (company_id, card_id, member_id, action, source, created_at)
  select v_company, c.id, null, x.action, 'sales', timestamptz '2026-09-15 16:10:00+00' + (x.n || ' minutes')::interval
    from (values ('rpr-01','like',1), ('rpr-02','fasttrack',2), ('rpr-04','like',3), ('rpr-06','like',4), ('rpr-07','pass',5))
         as x(key, action, n)
    join cards c on c.company_id = v_company and c.card_key = x.key;
  insert into decisions (company_id, card_id, member_id, action, updated_at)
  select v_company, c.id, null, x.action, now()
    from (values ('rpr-01','like'), ('rpr-02','fasttrack'), ('rpr-04','like'), ('rpr-06','like'), ('rpr-07','pass')) as x(key, action)
    join cards c on c.company_id = v_company and c.card_key = x.key;

  -- Sam in the portal: agree on rpr-06, split on rpr-02, timing on rpr-04.
  insert into swipe_events (company_id, card_id, member_id, action, source, created_at)
  select v_company, c.id, v_sam, x.action, 'portal', timestamptz '2026-09-22 09:30:00+00' + (x.n || ' minutes')::interval
    from (values ('rpr-06','like',1), ('rpr-02','pass',2), ('rpr-04','save',3)) as x(key, action, n)
    join cards c on c.company_id = v_company and c.card_key = x.key;
  insert into decisions (company_id, card_id, member_id, action, updated_at)
  select v_company, c.id, v_sam, x.action, now()
    from (values ('rpr-06','like'), ('rpr-02','pass'), ('rpr-04','save')) as x(key, action)
    join cards c on c.company_id = v_company and c.card_key = x.key;

  -- Library: one delivered pillar, two approved-unwritten insights.
  insert into articles (company_id, card_id, format, title, status, body_html, google_doc_url, delivered_at)
  select v_company, c.id, c.format, c.title, 'delivered',
         '<h2 class="gd-h">8th Wall is open source. Now what?</h2>'
      || '<p style="margin:0">On February 28, 2026, 8th Wall''s hosted platform shut down. The engine is now MIT-licensed, '
      || 'but SLAM, VPS, Maps and hand tracking did not come with it. <strong>Every guide to what comes next is written by a vendor.</strong></p>'
      || '<h2>What you actually lost</h2><ul><li>World tracking (SLAM)</li><li>Visual positioning (VPS)</li><li>Hand tracking</li></ul>'
      || '<h3>The shortlist</h3><p>Zapworks, Kivicube, Blippar and Arloopa each cover part of it. '
      || '<a href="https://8thwall.org/blog/8th-wall-open-source">Read the announcement</a>.</p>',
         'https://docs.google.com/document/d/portal-test-rpr-01/edit',
         timestamptz '2026-09-22 14:00:00+00'
    from cards c where c.company_id = v_company and c.card_key = 'rpr-01';
  insert into articles (company_id, card_id, format, title, status)
  select v_company, c.id, c.format, c.title, 'approved_unwritten'
    from cards c where c.company_id = v_company and c.card_key in ('rpr-04','rpr-05');

  update companies set hub_unlocked = false where id = v_company;
end $$;
