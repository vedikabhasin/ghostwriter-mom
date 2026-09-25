-- ---------------------------------------------------------------------------
-- Portal RPCs (Session B).
-- No table or column changes. Two security-definer functions cover the only
-- portal writes that RLS does not already allow:
--   * decisions has no insert/update policy for members  -> portal_decide
--   * articles has no update policy for members          -> portal_set_live
-- Both check membership against auth.uid() and refuse writes once a canceled
-- subscription has ended (the portal is read-only Library at that point).
-- ---------------------------------------------------------------------------

create or replace function portal_can_write(p_company_id uuid) returns boolean
language sql security definer stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from companies c
    where c.id = p_company_id
      and not (
        c.subscription_status = 'canceled'
        and c.subscription_ends_at is not null
        and c.subscription_ends_at <= now()
      )
  );
$$;

-- Record a member's decision on a card: upsert the current-state row and
-- append to swipe_events (source 'portal'). Returns the previous action, or
-- null if this is the member's first decision on the card.
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

  if not portal_can_write(v_company_id) then
    raise exception 'subscription ended' using errcode = 'insufficient_privilege';
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

-- Toggle an article between delivered and live. Only delivered/live rows
-- move; approved_unwritten stays put.
create or replace function portal_set_live(p_article_id uuid, p_live boolean) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_article articles%rowtype;
begin
  select * into v_article from articles where id = p_article_id;
  if not found or not is_company_member(v_article.company_id) then
    raise exception 'unknown article' using errcode = 'no_data_found';
  end if;
  if not portal_can_write(v_article.company_id) then
    raise exception 'subscription ended' using errcode = 'insufficient_privilege';
  end if;
  if v_article.status not in ('delivered','live') then
    raise exception 'article not delivered yet' using errcode = 'invalid_parameter_value';
  end if;

  update articles
     set status  = case when p_live then 'live' else 'delivered' end,
         live_at = case when p_live then coalesce(live_at, now()) else null end
   where id = p_article_id
   returning * into v_article;

  return jsonb_build_object('id', v_article.id, 'status', v_article.status, 'live_at', v_article.live_at);
end;
$$;

revoke execute on function portal_can_write(uuid)           from public, anon;
revoke execute on function portal_decide(uuid, text)         from public, anon;
revoke execute on function portal_set_live(uuid, boolean)    from public, anon;
grant  execute on function portal_can_write(uuid)           to authenticated;
grant  execute on function portal_decide(uuid, text)         to authenticated;
grant  execute on function portal_set_live(uuid, boolean)    to authenticated;
