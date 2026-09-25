-- ---------------------------------------------------------------------------
-- Row Level Security
-- Signed-in users can only see rows for companies they are a member of.
-- The anonymous sales page has NO direct table access — only the three RPCs
-- in migration 3, which are `security definer`.
-- ---------------------------------------------------------------------------
alter table companies     enable row level security;
alter table members       enable row level security;
alter table cards         enable row level security;
alter table swipe_events  enable row level security;
alter table decisions     enable row level security;
alter table approvals     enable row level security;
alter table articles      enable row level security;
alter table signals       enable row level security;
alter table notes         enable row level security;
alter table stripe_events enable row level security;

-- Membership check used by every policy. security definer + stable + fixed
-- search_path avoids the "policy calls policy" recursion issue.
create or replace function is_company_member(p_company_id uuid) returns boolean
language sql security definer stable set search_path = public
as $$
  select exists (
    select 1 from members m
    where m.company_id = p_company_id and m.user_id = auth.uid()
  );
$$;

-- Companies: read only, only your own.
create policy companies_select on companies
  for select to authenticated
  using (is_company_member(id));

-- Members: everyone on the team can see each other; each member can update
-- their own display_name / avatar_shape / onboarding.
create policy members_select on members
  for select to authenticated
  using (is_company_member(company_id));
create policy members_update_self on members
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Cards, approvals, articles, signals: read only for team members.
create policy cards_select      on cards      for select to authenticated using (is_company_member(company_id));
create policy approvals_select  on approvals  for select to authenticated using (is_company_member(company_id));
create policy articles_select   on articles   for select to authenticated using (is_company_member(company_id));
create policy signals_select    on signals    for select to authenticated using (is_company_member(company_id));

-- Swipe events: read for team; insert only via RPC. A signed-in member can
-- insert their own portal-side swipes though — the RPC handles the anon case.
create policy swipe_events_select on swipe_events
  for select to authenticated
  using (is_company_member(company_id));
create policy swipe_events_insert on swipe_events
  for insert to authenticated
  with check (
    is_company_member(company_id)
    and source = 'portal'
    and (member_id is null or (select user_id from members where id = member_id) = auth.uid())
  );

-- Decisions: read for team.
create policy decisions_select on decisions
  for select to authenticated
  using (is_company_member(company_id));

-- Notes: read all, insert / update / delete only your own rows.
create policy notes_select on notes
  for select to authenticated
  using (is_company_member(company_id));
create policy notes_insert on notes
  for insert to authenticated
  with check (
    is_company_member(company_id)
    and (select user_id from members where id = member_id) = auth.uid()
  );
create policy notes_update_own on notes
  for update to authenticated
  using ((select user_id from members where id = member_id) = auth.uid());
create policy notes_delete_own on notes
  for delete to authenticated
  using ((select user_id from members where id = member_id) = auth.uid());

-- stripe_events: no direct access. The webhook edge function uses the service
-- role which bypasses RLS anyway; this policy just documents intent.
-- (No policy => deny all for anon and authenticated.)
