-- ---------------------------------------------------------------------------
-- Call-mode portal, on top of 20260928000011_call_mode.sql.
--   * hub_access          internal, hub_unlocked, or any credit grant (manual
--                         grants count). No longer follows portal_active, so
--                         the 30-day window alone does not open the Hub.
--                         Every company whose Hub is open when this runs gets
--                         hub_unlocked = true first, so nothing open today
--                         locks.
--   * portal_decide       any member can swipe, whatever the access window.
--                         An expired portal keeps its feed history working.
--   * portal_account      portal_active() instead of subscription_status,
--                         plus unlock_mode and portal_access_until.
--   * articles clock      moving an article to 'writing' by hand starts the
--                         24h clock; 'delivered' stamps delivered_at.
--   * credits (frozen)    spend_credits and the pieces triggers move to the
--                         requested / writing / delivered statuses.
-- ---------------------------------------------------------------------------

-- Keep every open Hub open before hub_access changes meaning.
update companies c set hub_unlocked = true
 where not c.hub_unlocked and not c.is_internal and hub_access(c.id);

create or replace function hub_access(p_company_id uuid) returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from companies c
     where c.id = p_company_id
       and (c.is_internal
            or c.hub_unlocked
            or exists (select 1 from credit_ledger l
                        where l.company_id = c.id and l.kind = 'grant'))
  );
$$;
revoke execute on function hub_access(uuid) from public, anon;
grant  execute on function hub_access(uuid) to authenticated;

-- Swipes are always allowed for members. Requests and live toggles still
-- need portal_active.
create or replace function portal_decide(p_card_id uuid, p_action text) returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
  v_member_id  uuid;
  v_prev       text;
begin
  if p_action not in ('like','pass','save','fasttrack') then
    raise exception 'invalid action %', p_action using errcode = 'invalid_parameter_value';
  end if;

  select company_id into v_company_id from cards where id = p_card_id;
  if v_company_id is null then
    raise exception 'unknown card' using errcode = 'no_data_found';
  end if;

  select id into v_member_id from members
    where company_id = v_company_id and user_id = auth.uid();
  if v_member_id is null then
    raise exception 'not a member' using errcode = 'insufficient_privilege';
  end if;

  select action into v_prev from decisions
    where company_id = v_company_id and card_id = p_card_id and member_id = v_member_id;

  insert into swipe_events (company_id, card_id, member_id, action, source)
    values (v_company_id, p_card_id, v_member_id, p_action, 'portal');

  insert into decisions (company_id, card_id, member_id, action, updated_at)
    values (v_company_id, p_card_id, v_member_id, p_action, now())
  on conflict (company_id, card_id, member_id) do update
    set action = excluded.action, updated_at = now();

  return v_prev;
end;
$$;
grant execute on function portal_decide(uuid, text) to authenticated;

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
    'balance',             credit_balance(p_company_id),
    'costs',               credit_costs(),
    'hub_access',          hub_access(p_company_id),
    'portal_active',       portal_active(p_company_id),
    'unlock_mode',         c.unlock_mode,
    'portal_access_until', c.portal_access_until,
    'can_resume',          c.subscription_status = 'canceled' and c.subscription_ends_at > now() and c.stripe_subscription_id is not null,
    'ever_bought',         exists (select 1 from credit_ledger l where l.company_id = p_company_id and l.kind = 'grant' and l.product in ('starter','plan','topup')),
    'starter_bought',      exists (select 1 from credit_ledger l where l.company_id = p_company_id and l.kind = 'grant' and l.product = 'starter'),
    'plan_active',         c.plan_subscription_id is not null,
    'next_expiry',         (select min(expires_at) from credit_grants(p_company_id) where remaining > 0 and expires_at > now())
  );
end;
$$;
grant execute on function portal_account(uuid) to authenticated;

-- Hand-moved statuses keep their stamps in step.
create or replace function articles_on_status() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'writing' and old.status is distinct from 'writing' then
    new.requested_at := coalesce(new.requested_at, now());
    new.deliver_by   := coalesce(new.deliver_by, now() + interval '24 hours');
  end if;
  if new.status = 'delivered' and old.status is distinct from 'delivered' then
    new.delivered_at := coalesce(new.delivered_at, now());
  end if;
  return new;
end;
$$;
drop trigger if exists articles_status on articles;
create trigger articles_status before update of status on articles
  for each row execute function articles_on_status();

-- Credits (frozen behind CREDITS_ENABLED in the portal) on the new statuses.
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
  if not portal_active(a.company_id) then
    raise exception 'portal closed' using errcode = 'insufficient_privilege';
  end if;

  perform 1 from companies where id = a.company_id for update;

  if a.status <> 'requested' then
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
    update articles set status = 'writing', requested_at = coalesce(requested_at, new.writing_at), deliver_by = new.deliver_by
     where id = new.article_id and status = 'requested';
  end if;
  if new.status = 'delivered' and new.delivered_at is null then
    new.delivered_at := now();
    update articles set status = 'delivered', delivered_at = new.delivered_at
     where id = new.article_id and status in ('requested','writing');
  end if;
  if new.status = 'killed' then
    if old.status = 'queued' then
      for r in select grant_id, sum(delta)::int as spent from credit_ledger
                where piece_id = new.id and kind = 'spend' group by grant_id loop
        insert into credit_ledger (company_id, delta, kind, grant_id, piece_id)
          values (new.company_id, -r.spent, 'refund', r.grant_id, new.id);
      end loop;
    end if;
    if old.status in ('queued','writing') then
      update articles set status = 'requested', deliver_by = null
       where id = new.article_id and status in ('requested','writing');
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
