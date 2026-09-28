-- ---------------------------------------------------------------------------
-- Call-mode pivot.
--   * companies.unlock_mode   'call' (default) or 'checkout'
--   * companies.portal_access_until   time-limited portal access without Stripe
--   * articles.requested_by   who called the card in from up_next
--   * articles.status         new four-value workflow (requested / writing /
--                             delivered; up_next is derived, never stored)
--   * portal_active(uuid)     one boolean covering every "should the portal
--                             let this company through" check
--   * request_card(uuid,text) idempotent RPC that moves a card from up_next
--                             (no article row) to requested (article row)
--   * submit_approval         now creates only the free pick's article row
--                             (status='writing'); every other liked card stays
--                             in decisions until the owner calls request_card
--   * portal_set_live         'live' collapses into 'delivered'; the toggle
--                             now just stamps live_at
--   * get_feed                returns unlock_mode so the sales page knows
--                             which post-approval section to render
--   * first_opened_at         backfilled from earliest swipe / approval /
--                             company created_at for every row where it was
--                             null
-- Additive on companies and articles. The check constraint on articles.status
-- is dropped and re-added after the row migration, so no data is lost.
-- ---------------------------------------------------------------------------

-- ---- companies ------------------------------------------------------------
alter table companies
  add column if not exists unlock_mode text not null default 'call'
    check (unlock_mode in ('call','checkout'));

alter table companies
  add column if not exists portal_access_until timestamptz;

-- Backfill first_opened_at once for every existing row. Chooses the earliest
-- signal we have: first anon swipe > first approval > company created_at.
update companies c set first_opened_at = sub.ts
  from (
    select c2.id,
           least(
             c2.created_at,
             coalesce((select min(e.created_at) from swipe_events e where e.company_id = c2.id), c2.created_at),
             coalesce((select min(a.approved_at) from approvals a where a.company_id = c2.id), c2.created_at)
           ) as ts
      from companies c2
     where c2.first_opened_at is null
  ) as sub
 where c.id = sub.id and c.first_opened_at is null;

-- ---- articles: new columns + status migration -----------------------------
alter table articles
  add column if not exists requested_by uuid references members(id) on delete set null;

-- Drop the old check so we can rewrite the values in place.
alter table articles drop constraint if exists articles_status_check;

-- 1. approved_unwritten + deliver_by set  -> writing (the free pick)
-- 2. approved_unwritten + deliver_by null  -> requested (still-to-be-requested)
-- 3. delivered                             -> delivered (unchanged)
-- 4. live                                  -> delivered (live_at stays set)
update articles
   set status = case
                  when status = 'approved_unwritten' and deliver_by is not null then 'writing'
                  when status = 'approved_unwritten' and deliver_by is null     then 'requested'
                  when status in ('delivered','live')                            then 'delivered'
                  else status
                end
 where status in ('approved_unwritten','delivered','live');

-- Any row where status = 'live' also gets a valid live_at (already true for
-- every row that was live: portal_set_live() always stamped it), so nothing
-- else to backfill.

alter table articles
  add constraint articles_status_check
  check (status in ('requested','writing','delivered'));

alter table articles alter column status set default 'requested';

-- ---- portal_active --------------------------------------------------------
-- Single source of truth for "portal writes / reads allowed for this company".
-- Reads: subscription still live, or an explicit portal_access_until window
-- that hasn't closed, or the internal flag. Every RPC that previously read
-- subscription_status now goes through this. The credits-era version of this
-- function only checked subscription_status='active'; we replace it.
create or replace function portal_active(p_company_id uuid) returns boolean
language sql security definer stable
set search_path = public, pg_temp
as $$
  select coalesce((
    select
      c.is_internal
      or (c.subscription_status = 'active')
      or (c.portal_access_until is not null and c.portal_access_until > now())
    from companies c
    where c.id = p_company_id
  ), false);
$$;
revoke execute on function portal_active(uuid) from public, anon;
grant  execute on function portal_active(uuid) to authenticated;

-- hub_access: the credits-era version required a credit grant. Under call mode
-- credits are frozen, so hub access follows portal_active. hub_unlocked stays
-- as an explicit override so an admin can open the Hub without portal access.
create or replace function hub_access(p_company_id uuid) returns boolean
language sql security definer stable
set search_path = public, pg_temp
as $$
  select coalesce((
    select
      c.is_internal or c.hub_unlocked or portal_active(c.id)
    from companies c
    where c.id = p_company_id
  ), false);
$$;
revoke execute on function hub_access(uuid) from public, anon;
grant  execute on function hub_access(uuid) to authenticated;

-- portal_can_write now just delegates. Kept so existing callers don't break.
create or replace function portal_can_write(p_company_id uuid) returns boolean
language sql security definer stable
set search_path = public, pg_temp
as $$
  select portal_active(p_company_id);
$$;

-- ---- request_card ---------------------------------------------------------
-- Move a card from up_next (no articles row) to requested. Idempotent when the
-- current status is 'requested'; refuses when 'writing' or 'delivered'.
-- p_format lets the caller commit to a format at request time (owner may have
-- swiped fasttrack on a card seeded as insight, for example). Nulls fall back
-- to the card's own format.
create or replace function request_card(p_card_id uuid, p_format text default null)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_card       cards%rowtype;
  v_member_id  uuid;
  v_existing   articles%rowtype;
  v_format     text;
  v_article    articles%rowtype;
begin
  select * into v_card from cards where id = p_card_id;
  if v_card.id is null then
    raise exception 'unknown card' using errcode = 'no_data_found';
  end if;

  select id into v_member_id from members
    where company_id = v_card.company_id and user_id = auth.uid();
  if v_member_id is null then
    raise exception 'not a member' using errcode = 'insufficient_privilege';
  end if;

  if not portal_active(v_card.company_id) then
    raise exception 'portal closed' using errcode = 'insufficient_privilege';
  end if;

  v_format := coalesce(nullif(trim(coalesce(p_format, '')), ''), v_card.format);
  if v_format not in ('pillar','insight','post') then
    raise exception 'invalid format %', v_format using errcode = 'invalid_parameter_value';
  end if;

  select * into v_existing from articles
   where company_id = v_card.company_id and card_id = v_card.id;

  if v_existing.id is not null then
    if v_existing.status in ('writing','delivered') then
      raise exception 'card already %', v_existing.status using errcode = 'invalid_parameter_value';
    end if;
    -- Already requested: idempotent, update format+requested_by if needed.
    update articles
       set format = v_format,
           requested_by = coalesce(requested_by, v_member_id),
           requested_at = coalesce(requested_at, now())
     where id = v_existing.id
     returning * into v_article;
  else
    insert into articles (company_id, card_id, format, title, status, requested_by, requested_at)
      values (v_card.company_id, v_card.id, v_format, v_card.title, 'requested', v_member_id, now())
      returning * into v_article;
  end if;

  return jsonb_build_object(
    'id',           v_article.id,
    'card_id',      v_article.card_id,
    'status',       v_article.status,
    'format',       v_article.format,
    'requested_at', v_article.requested_at,
    'requested_by', v_article.requested_by
  );
end;
$$;
revoke execute on function request_card(uuid, text) from public, anon;
grant  execute on function request_card(uuid, text) to authenticated;

-- ---- submit_approval ------------------------------------------------------
-- Under call mode the free pick is the only guaranteed article. Other liked
-- cards stay in decisions/swipe_events until the owner calls request_card
-- from the portal. So this now creates exactly one articles row.
create or replace function submit_approval(
  p_slug                text,
  p_free_card_key       text,
  p_direction_card_keys text[],
  p_email               text
) returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id     uuid;
  v_free_card      cards%rowtype;
  v_direction_ids  uuid[] := '{}';
  v_key            text;
  v_id             uuid;
  v_approval_id    uuid;
  v_now            timestamptz := now();
  v_deliver_by     timestamptz := v_now + interval '24 hours';
  v_normalized     text;
begin
  select id into v_company_id from companies where slug = p_slug;
  if v_company_id is null then
    raise exception 'unknown slug %', p_slug using errcode = 'no_data_found';
  end if;

  select * into v_free_card from cards
    where company_id = v_company_id and card_key = p_free_card_key;
  if v_free_card.id is null then
    raise exception 'unknown free_card_key % for slug %', p_free_card_key, p_slug
      using errcode = 'no_data_found';
  end if;

  if p_direction_card_keys is null or array_length(p_direction_card_keys, 1) is null then
    raise exception 'direction_card_keys must be non-empty'
      using errcode = 'invalid_parameter_value';
  end if;

  foreach v_key in array p_direction_card_keys loop
    select id into v_id from cards
      where company_id = v_company_id and card_key = v_key;
    if v_id is null then
      raise exception 'unknown direction_card_key % for slug %', v_key, p_slug
        using errcode = 'no_data_found';
    end if;
    v_direction_ids := v_direction_ids || v_id;
  end loop;

  v_normalized := nullif(trim(coalesce(p_email, '')), '');

  insert into approvals (company_id, free_article_card_id, direction_card_ids, email, deliver_by)
    values (v_company_id, v_free_card.id, v_direction_ids, v_normalized, v_deliver_by)
    returning id into v_approval_id;

  -- Only the free pick becomes an articles row. Status jumps straight to
  -- 'writing' because the 24-hour clock is already running.
  -- The unique index on (company_id, card_id) is partial (WHERE card_id IS
  -- NOT NULL). ON CONFLICT needs to match that predicate exactly, so guard
  -- against duplicates with a lookup instead.
  if exists (select 1 from articles
              where company_id = v_company_id and card_id = v_free_card.id) then
    update articles
       set status       = case when status = 'delivered' then status else 'writing' end,
           requested_at = coalesce(requested_at, v_now),
           deliver_by   = coalesce(deliver_by, v_deliver_by)
     where company_id = v_company_id and card_id = v_free_card.id;
  else
    insert into articles (company_id, card_id, format, title, status, requested_at, deliver_by)
      values (v_company_id, v_free_card.id, v_free_card.format, v_free_card.title,
              'writing', v_now, v_deliver_by);
  end if;

  return v_approval_id;
end;
$$;
grant execute on function submit_approval(text, text, text[], text) to anon, authenticated;

-- ---- portal_set_live ------------------------------------------------------
-- 'live' is no longer a status, so this stamps live_at without touching status.
-- Returns the article's id + status + live_at so the portal can re-render.
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
  if not portal_active(v_article.company_id) then
    raise exception 'portal closed' using errcode = 'insufficient_privilege';
  end if;
  if v_article.status <> 'delivered' then
    raise exception 'article not delivered yet' using errcode = 'invalid_parameter_value';
  end if;

  update articles
     set live_at = case when p_live then coalesce(live_at, now()) else null end
   where id = p_article_id
   returning * into v_article;

  return jsonb_build_object(
    'id',      v_article.id,
    'status',  v_article.status,
    'live_at', v_article.live_at
  );
end;
$$;

-- ---- get_feed -------------------------------------------------------------
-- One new field: unlock_mode. Everything else is unchanged.
create or replace function get_feed(p_slug text) returns jsonb
language plpgsql security definer stable
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

  select jsonb_build_object(
    'slug',               v_company.slug,
    'name',               v_company.name,
    'contact_first_name', v_company.contact_first_name,
    'email_known',        v_company.email_known,
    'direction_shape',    v_company.direction_shape,
    'offer_text',         v_company.offer_text,
    'first_opened_at',    v_company.first_opened_at,
    'show_scarcity',      v_company.show_scarcity,
    'unlock_mode',        v_company.unlock_mode,
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
