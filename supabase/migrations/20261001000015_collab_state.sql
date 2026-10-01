-- ---------------------------------------------------------------------------
-- Shared state for the "collab3" sales flow (templates/swipe2.html).
--
-- One link, many devices: a visitor, their colleague, or the same visitor on
-- a new phone all see the same swipes, the same auto-picked article and the
-- same log. Swipes and reactions already live in swipe_events / decisions
-- (log_swipe, keyed by slug). This adds:
--   * collab_picks       the auto-picked card per company. First write wins,
--                        so the pick never changes once made.
--   * get_collab_state   read everything for a slug in one call (anon). The
--                        approval email is never returned.
--   * set_collab_pick    store the pick (anon, first write wins).
-- Additive only: no existing table, function or row changes.
-- ---------------------------------------------------------------------------

create table if not exists collab_picks (
  company_id uuid primary key references companies(id) on delete cascade,
  card_id    uuid not null references cards(id) on delete cascade,
  picked_at  timestamptz not null default now()
);
-- Read and written only through the security-definer functions below.
alter table collab_picks enable row level security;
revoke all on collab_picks from anon, authenticated;

create or replace function get_collab_state(p_slug text) returns jsonb
language plpgsql security definer stable
set search_path = public, pg_temp
as $$
declare
  v_company companies%rowtype;
begin
  select * into v_company from companies where slug = p_slug;
  if not found or v_company.is_internal then
    raise exception 'unknown slug %', p_slug using errcode = 'no_data_found';
  end if;

  return jsonb_build_object(
    -- The sales page's shared reactions: one per card (anonymous seat).
    'decisions', coalesce((
      select jsonb_agg(jsonb_build_object('card_key', c.card_key, 'action', d.action, 'updated_at', d.updated_at)
                       order by c.sort_order, c.card_key)
      from decisions d join cards c on c.id = d.card_id
      where d.company_id = v_company.id and d.member_id is null
    ), '[]'::jsonb),
    -- Every sales-page swipe, oldest first: the log.
    'log', coalesce((
      select jsonb_agg(jsonb_build_object('card_key', c.card_key, 'action', s.action, 'created_at', s.created_at)
                       order by s.created_at, s.id)
      from swipe_events s join cards c on c.id = s.card_id
      where s.company_id = v_company.id and s.member_id is null and s.source = 'sales'
    ), '[]'::jsonb),
    'pick', (
      select jsonb_build_object('card_key', c.card_key, 'picked_at', p.picked_at)
      from collab_picks p join cards c on c.id = p.card_id
      where p.company_id = v_company.id
    ),
    -- The latest approval, without its email.
    'approval', (
      select jsonb_build_object('card_key', c.card_key, 'approved_at', a.approved_at, 'deliver_by', a.deliver_by)
      from approvals a left join cards c on c.id = a.free_article_card_id
      where a.company_id = v_company.id
      order by a.approved_at desc
      limit 1
    )
  );
end;
$$;
grant execute on function get_collab_state(text) to anon, authenticated;

create or replace function set_collab_pick(p_slug text, p_card_key text) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
  v_card_id    uuid;
begin
  select id into v_company_id from companies where slug = p_slug and not is_internal;
  if v_company_id is null then
    raise exception 'unknown slug %', p_slug using errcode = 'no_data_found';
  end if;
  select id into v_card_id from cards where company_id = v_company_id and card_key = p_card_key;
  if v_card_id is null then
    raise exception 'unknown card_key % for slug %', p_card_key, p_slug using errcode = 'no_data_found';
  end if;

  insert into collab_picks (company_id, card_id) values (v_company_id, v_card_id)
  on conflict (company_id) do nothing;

  return (
    select jsonb_build_object('card_key', c.card_key, 'picked_at', p.picked_at)
    from collab_picks p join cards c on c.id = p.card_id
    where p.company_id = v_company_id
  );
end;
$$;
grant execute on function set_collab_pick(text, text) to anon, authenticated;
