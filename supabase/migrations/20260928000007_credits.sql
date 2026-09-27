-- ---------------------------------------------------------------------------
-- Credits: "$19 decides, credits make".
--
--   * credit_ledger: append-only. A grant row carries the credits and their
--     expiry; every spend, refund, expire or adjust row points at the grant it
--     draws from (grant_id). A grant's remaining credits are its delta plus
--     its children's deltas, and they count only while the grant is
--     unexpired. So "balance = sum of unexpired rows", grouped by grant.
--   * pieces: what credits buy. queued -> writing -> delivered -> (revising
--     -> delivered) -> done, or killed. One piece per company in writing.
--   * companies: first_opened_at (weekly drop day), plan_subscription_id and
--     plan_period_end (the $2,000/month plan, separate from the $19).
--   * credit_costs(): the one place costs live. The portal reads it.
--   * hub_access(): who gets the Hub canvas.
--   * get_feed() now stamps first_opened_at on the sales page's first visit.
-- Additive. hub_unlocked keeps every Hub that is open today open.
-- ---------------------------------------------------------------------------

-- Companies ------------------------------------------------------------------
alter table companies add column if not exists first_opened_at      timestamptz;
alter table companies add column if not exists plan_subscription_id text;
alter table companies add column if not exists plan_period_end      timestamptz;

-- Backfill: the earliest sign of life we have.
update companies c
   set first_opened_at = least(
         coalesce((select min(s.created_at)  from swipe_events s where s.company_id = c.id), c.created_at),
         coalesce((select min(a.approved_at) from approvals a    where a.company_id = c.id), c.created_at),
         c.created_at)
 where c.first_opened_at is null;

-- Costs -----------------------------------------------------------------------
-- 1 credit = $100. "call" is a placeholder (no call UI yet): null = not sold.
create or replace function credit_costs() returns jsonb
language sql immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object('post', 1, 'insight', 3, 'pillar', 8, 'call', null, 'usd_per_credit', 100);
$$;
grant execute on function credit_costs() to anon, authenticated;

create or replace function credit_cost(p_format text) returns int
language sql immutable
set search_path = public, pg_temp
as $$
  select (credit_costs() ->> p_format)::int;
$$;
grant execute on function credit_cost(text) to authenticated;

-- Pieces ----------------------------------------------------------------------
create table if not exists pieces (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  article_id      uuid references articles(id) on delete set null,
  card_id         uuid references cards(id) on delete set null,
  format          text not null check (format in ('pillar','insight','post')),
  cost            int  not null check (cost > 0),
  status          text not null default 'queued'
                  check (status in ('queued','writing','delivered','revising','done','killed')),
  position        int  not null default 0,
  queued_at       timestamptz not null default now(),
  writing_at      timestamptz,
  deliver_by      timestamptz,
  delivered_at    timestamptz,
  revisions_used  int  not null default 0,
  created_by      uuid references members(id) on delete set null,
  updated_at      timestamptz not null default now()
);
create index if not exists pieces_company_id_idx on pieces (company_id);
-- One piece per company in writing at a time.
create unique index if not exists pieces_one_writing on pieces (company_id) where status = 'writing';
-- One live piece per article (killed ones don't count).
create unique index if not exists pieces_one_per_article on pieces (article_id) where status <> 'killed' and article_id is not null;

-- Ledger ----------------------------------------------------------------------
create table if not exists credit_ledger (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  delta       int  not null check (delta <> 0),
  kind        text not null check (kind in ('grant','spend','refund','expire','adjust')),
  product     text check (product in ('starter','plan','topup','manual')),
  grant_id    uuid references credit_ledger(id) on delete cascade,
  source_id   text,               -- Stripe checkout session / invoice / subscription id
  piece_id    uuid references pieces(id) on delete set null,
  expires_at  timestamptz,        -- grants only; null = no expiry while the $19 is active
  created_by  uuid references members(id) on delete set null,  -- the seat that spent
  created_at  timestamptz not null default now(),
  constraint credit_ledger_shape check (
    (kind = 'grant' and delta > 0 and grant_id is null and product is not null)
    or (kind <> 'grant' and grant_id is not null and expires_at is null)
  )
);
create index if not exists credit_ledger_company_idx on credit_ledger (company_id);
create index if not exists credit_ledger_grant_idx   on credit_ledger (grant_id);
create index if not exists credit_ledger_piece_idx   on credit_ledger (piece_id);
-- Webhook idempotency: one grant per Stripe checkout session or invoice.
create unique index if not exists credit_ledger_grant_source on credit_ledger (source_id) where kind = 'grant';

-- Grants with what's left on each. Invoker rights: members see their own
-- company through RLS, the service role sees everything.
create or replace function credit_grants(p_company_id uuid)
returns table (grant_id uuid, product text, remaining int, expires_at timestamptz, created_at timestamptz)
language sql stable security invoker
set search_path = public, pg_temp
as $$
  select g.id, g.product,
         (g.delta + coalesce((select sum(c.delta) from credit_ledger c where c.grant_id = g.id), 0))::int,
         g.expires_at, g.created_at
    from credit_ledger g
   where g.company_id = p_company_id and g.kind = 'grant';
$$;

-- Balance: remaining credits on unexpired grants.
create or replace function credit_balance(p_company_id uuid) returns int
language sql stable security invoker
set search_path = public, pg_temp
as $$
  select coalesce(sum(greatest(remaining, 0)), 0)::int
    from credit_grants(p_company_id)
   where expires_at is null or expires_at > now();
$$;
grant execute on function credit_grants(uuid)  to authenticated;
grant execute on function credit_balance(uuid) to authenticated;

-- Take p_amount credits, soonest-expiring grant first (no expiry last,
-- then oldest first). Writes one row per grant touched. Caller holds the
-- company lock. Returns false (and writes nothing) if there isn't enough.
create or replace function credit_take(
  p_company_id uuid, p_amount int, p_kind text, p_piece_id uuid, p_member_id uuid, p_source_id text
) returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  g record;
  v_need int := p_amount;
  v_take int;
begin
  if p_amount <= 0 then return true; end if;
  if credit_balance(p_company_id) < p_amount then return false; end if;
  for g in
    select * from credit_grants(p_company_id)
     where remaining > 0 and (expires_at is null or expires_at > now())
     order by expires_at asc nulls last, created_at asc
  loop
    exit when v_need <= 0;
    v_take := least(v_need, g.remaining);
    insert into credit_ledger (company_id, delta, kind, grant_id, piece_id, created_by, source_id)
      values (p_company_id, -v_take, p_kind, g.grant_id, p_piece_id, p_member_id, p_source_id);
    v_need := v_need - v_take;
  end loop;
  return true;
end;
$$;
revoke execute on function credit_take(uuid, int, text, uuid, uuid, text) from public, anon, authenticated;

-- Access ------------------------------------------------------------------------
-- An active $19 portal (not canceled, not past its end).
create or replace function portal_active(p_company_id uuid) returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from companies c where c.id = p_company_id and c.subscription_status = 'active');
$$;

-- Hub canvas: internal, or open today (hub_unlocked), or at least one credit
-- purchase with an active $19. Stays open at 0 balance.
create or replace function hub_access(p_company_id uuid) returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from companies c
     where c.id = p_company_id
       and (c.is_internal
            or c.hub_unlocked
            or (c.subscription_status = 'active'
                and exists (select 1 from credit_ledger l
                             where l.company_id = c.id and l.kind = 'grant'
                               and l.product in ('starter','plan','topup'))))
  );
$$;
grant execute on function portal_active(uuid) to authenticated;
grant execute on function hub_access(uuid)    to authenticated;

-- Everything the portal needs to gate itself, for the caller's company.
create or replace function portal_account(p_company_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  c companies%rowtype;
begin
  if not is_company_member(p_company_id) then
    raise exception 'not a member' using errcode = 'insufficient_privilege';
  end if;
  select * into c from companies where id = p_company_id;
  return jsonb_build_object(
    'balance',          credit_balance(p_company_id),
    'costs',            credit_costs(),
    'hub_access',       hub_access(p_company_id),
    'portal_active',    c.subscription_status = 'active',
    'can_resume',       c.subscription_status = 'canceled' and c.subscription_ends_at > now() and c.stripe_subscription_id is not null,
    'ever_bought',      exists (select 1 from credit_ledger l where l.company_id = p_company_id and l.kind = 'grant' and l.product in ('starter','plan','topup')),
    'starter_bought',   exists (select 1 from credit_ledger l where l.company_id = p_company_id and l.kind = 'grant' and l.product = 'starter'),
    'plan_active',      c.plan_subscription_id is not null,
    'next_expiry',      (select min(expires_at) from credit_grants(p_company_id) where remaining > 0 and expires_at > now())
  );
end;
$$;
grant execute on function portal_account(uuid) to authenticated;

-- Spend: "Write this" --------------------------------------------------------------
-- Creates a queued piece for an approved, unwritten article and spends its
-- cost. The first piece with nothing in writing moves straight to writing.
create or replace function spend_credits(p_article_id uuid, p_format text) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  a         articles%rowtype;
  v_member  uuid;
  v_cost    int := credit_cost(p_format);
  v_piece   pieces%rowtype;
begin
  if v_cost is null or p_format not in ('pillar','insight','post') then
    raise exception 'invalid format %', p_format using errcode = 'invalid_parameter_value';
  end if;
  select * into a from articles where id = p_article_id;
  if not found then raise exception 'unknown article' using errcode = 'no_data_found'; end if;

  select id into v_member from members where company_id = a.company_id and user_id = auth.uid()
   order by created_at limit 1;
  if v_member is null then raise exception 'not a member' using errcode = 'insufficient_privilege'; end if;
  if not portal_can_write(a.company_id) then
    raise exception 'subscription ended' using errcode = 'insufficient_privilege';
  end if;

  -- One spend at a time per company.
  perform 1 from companies where id = a.company_id for update;

  if a.status <> 'approved_unwritten' or a.requested_at is not null then
    raise exception 'not writable' using errcode = 'check_violation';
  end if;
  if exists (select 1 from pieces where article_id = a.id and status <> 'killed') then
    raise exception 'already queued' using errcode = 'unique_violation';
  end if;

  insert into pieces (company_id, article_id, card_id, format, cost, status, position, created_by)
    values (a.company_id, a.id, a.card_id, p_format, v_cost, 'queued',
            coalesce((select max(position) from pieces where company_id = a.company_id), 0) + 1, v_member)
    returning * into v_piece;

  if not credit_take(a.company_id, v_cost, 'spend', v_piece.id, v_member, null) then
    raise exception 'insufficient_credits' using errcode = 'check_violation';
  end if;

  update articles set format = p_format where id = a.id;
  perform pieces_advance(a.company_id);
  select * into v_piece from pieces where id = v_piece.id;
  return jsonb_build_object('piece', to_jsonb(v_piece), 'balance', credit_balance(a.company_id));
end;
$$;
grant execute on function spend_credits(uuid, text) to authenticated;

-- Queue: if nothing is in writing, the oldest queued piece starts.
create or replace function pieces_advance(p_company_id uuid) returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_next uuid;
begin
  if exists (select 1 from pieces where company_id = p_company_id and status = 'writing') then return; end if;
  select id into v_next from pieces where company_id = p_company_id and status = 'queued'
   order by position, queued_at limit 1;
  if v_next is not null then update pieces set status = 'writing' where id = v_next; end if;
end;
$$;
revoke execute on function pieces_advance(uuid) from public, anon, authenticated;

-- Status moves (you change status by hand in Supabase; this keeps the rest
-- in step): clock, article row, refunds, one revision, next in queue.
create or replace function pieces_on_status() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare r record;
begin
  if new.status = old.status then new.updated_at := now(); return new; end if;
  if not (
       (old.status = 'queued'    and new.status in ('writing','killed'))
    or (old.status = 'writing'   and new.status in ('delivered','killed'))
    or (old.status = 'delivered' and new.status in ('revising','done','killed'))
    or (old.status = 'revising'  and new.status in ('delivered','done','killed'))
  ) then
    raise exception 'pieces: % -> % is not allowed', old.status, new.status using errcode = 'check_violation';
  end if;
  if new.status = 'revising' then
    if old.revisions_used >= 1 then
      raise exception 'pieces: one revision round is included' using errcode = 'check_violation';
    end if;
    new.revisions_used := old.revisions_used + 1;
  end if;
  if new.status = 'writing' then
    new.writing_at := now();
    new.deliver_by := now() + interval '24 hours';
    update articles set requested_at = new.writing_at, deliver_by = new.deliver_by where id = new.article_id;
  end if;
  if new.status = 'delivered' and new.delivered_at is null then
    new.delivered_at := now();
    update articles set status = 'delivered', delivered_at = new.delivered_at
     where id = new.article_id and status = 'approved_unwritten';
  end if;
  if new.status = 'killed' then
    if old.status = 'queued' then
      -- Killed before writing: every credit goes back to its own grant.
      for r in select grant_id, sum(delta)::int as spent from credit_ledger
                where piece_id = new.id and kind = 'spend' group by grant_id loop
        insert into credit_ledger (company_id, delta, kind, grant_id, piece_id)
          values (new.company_id, -r.spent, 'refund', r.grant_id, new.id);
      end loop;
    end if;
    -- The card can be written again; after delivery, credits stay spent.
    if old.status in ('queued','writing') then
      update articles set requested_at = null, deliver_by = null
       where id = new.article_id and status = 'approved_unwritten';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists pieces_status on pieces;
create trigger pieces_status before update of status on pieces
  for each row execute function pieces_on_status();

create or replace function pieces_after_status() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if old.status = 'writing' and new.status <> 'writing' then
    perform pieces_advance(new.company_id);
  end if;
  return null;
end;
$$;
drop trigger if exists pieces_status_after on pieces;
create trigger pieces_status_after after update of status on pieces
  for each row execute function pieces_after_status();

-- Stripe-side credit rules (service role only) --------------------------------------
-- Rollover cap: on a new plan grant, carried-over plan credits above p_cap
-- expire, soonest-expiring first.
create or replace function credits_cap_rollover(p_company_id uuid, p_cap int, p_source_id text) returns int
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  g record;
  v_over int;
  v_take int;
  v_done int := 0;
begin
  select coalesce(sum(remaining), 0) - p_cap into v_over from credit_grants(p_company_id)
   where product = 'plan' and remaining > 0 and (expires_at is null or expires_at > now());
  for g in select * from credit_grants(p_company_id)
            where product = 'plan' and remaining > 0 and (expires_at is null or expires_at > now())
            order by expires_at asc nulls last, created_at asc loop
    exit when v_over <= 0;
    v_take := least(v_over, g.remaining);
    insert into credit_ledger (company_id, delta, kind, grant_id, source_id)
      values (p_company_id, -v_take, 'expire', g.grant_id, p_source_id);
    v_over := v_over - v_take;
    v_done := v_done + v_take;
  end loop;
  return v_done;
end;
$$;

-- Plan cancelled while the $19 is active: remaining credits with an expiry
-- now last until p_days after the cancellation (never shorter than before),
-- so the extension is at most p_days. No-expiry grants stay as they are.
create or replace function credits_extend(p_company_id uuid, p_days int) returns int
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_n int;
begin
  update credit_ledger l
     set expires_at = greatest(l.expires_at, now() + make_interval(days => p_days))
   where l.company_id = p_company_id and l.kind = 'grant'
     and l.expires_at is not null and l.expires_at > now()
     and exists (select 1 from credit_grants(p_company_id) g where g.grant_id = l.id and g.remaining > 0);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- $19 cancelled: every remaining credit expires.
create or replace function credits_expire_all(p_company_id uuid, p_source_id text) returns int
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  g record;
  v_done int := 0;
begin
  for g in select * from credit_grants(p_company_id)
            where remaining > 0 and (expires_at is null or expires_at > now()) loop
    insert into credit_ledger (company_id, delta, kind, grant_id, source_id)
      values (p_company_id, -g.remaining, 'expire', g.grant_id, p_source_id);
    v_done := v_done + g.remaining;
  end loop;
  return v_done;
end;
$$;
revoke execute on function credits_cap_rollover(uuid, int, text) from public, anon, authenticated;
revoke execute on function credits_extend(uuid, int)             from public, anon, authenticated;
revoke execute on function credits_expire_all(uuid, text)        from public, anon, authenticated;

-- RLS ---------------------------------------------------------------------------
alter table credit_ledger enable row level security;
alter table pieces        enable row level security;
drop policy if exists credit_ledger_select on credit_ledger;
drop policy if exists pieces_select        on pieces;
create policy credit_ledger_select on credit_ledger for select to authenticated using (is_company_member(company_id));
create policy pieces_select        on pieces        for select to authenticated using (is_company_member(company_id));
-- No insert/update/delete policies: writes go through spend_credits, the
-- webhook (service role), or by hand in Supabase.

-- The Hub canvas is a credits feature. Notes are never locked: a note from
-- the Feed still gets its hub_items row.
drop policy if exists hub_items_insert on hub_items;
drop policy if exists hub_items_update on hub_items;
drop policy if exists hub_items_delete on hub_items;
create policy hub_items_insert on hub_items
  for insert to authenticated
  with check (
    is_company_member(company_id)
    and (kind = 'note' or hub_access(company_id))
    and (created_by is null or (select user_id from members where id = created_by) = auth.uid())
  );
create policy hub_items_update on hub_items
  for update to authenticated
  using (is_company_member(company_id) and hub_access(company_id))
  with check (is_company_member(company_id) and hub_access(company_id));
create policy hub_items_delete on hub_items
  for delete to authenticated
  using (is_company_member(company_id) and hub_access(company_id));

-- get_feed(): same output. Now volatile, because the sales page's first
-- visit stamps first_opened_at (portal calls never do).
create or replace function get_feed(p_slug text) returns jsonb
language plpgsql security definer volatile
set search_path = public, pg_temp
as $$
declare
  v_company companies%rowtype;
  v_result  jsonb;
begin
  select * into v_company from companies where slug = p_slug;
  if not found or v_company.is_internal then
    raise exception 'unknown slug %', p_slug using errcode = 'no_data_found';
  end if;

  if v_company.first_opened_at is null then
    update companies set first_opened_at = now() where id = v_company.id and first_opened_at is null;
  end if;

  select jsonb_build_object(
    'slug',               v_company.slug,
    'name',               v_company.name,
    'contact_first_name', v_company.contact_first_name,
    'email_known',        v_company.email_known,
    'direction_shape',    v_company.direction_shape,
    'offer_text',         v_company.offer_text,
    'cards', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',        c.id,
        'card_key',  c.card_key,
        'format',    c.format,
        'series',    c.series,
        'title',     c.title,
        'angle',     c.angle,
        'evidence',  c.evidence,
        'tags',      c.tags,
        'sources',   c.sources,
        'drop_date', c.drop_date
      ) order by c.sort_order, c.card_key)
      from cards c where c.company_id = v_company.id
    ), '[]'::jsonb),
    'signal', (
      select jsonb_build_object(
        'text',   s.text,
        'source', s.source,
        'date',   to_char(s.signal_date, 'YYYY-MM-DD')
      )
      from signals s
      where s.company_id = v_company.id
      order by s.signal_date desc, s.created_at desc
      limit 1
    )
  ) into v_result;

  return v_result;
end;
$$;
grant execute on function get_feed(text) to anon, authenticated;
