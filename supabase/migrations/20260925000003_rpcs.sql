-- ---------------------------------------------------------------------------
-- Public RPCs for the anonymous sales page.
-- All security definer + explicit search_path so the anon role can call them
-- without ever touching table policies directly. Each RPC verifies the slug.
-- ---------------------------------------------------------------------------

-- Return everything the sales page needs to render a feed: company display
-- fields, its cards (sorted), and the latest signal. Nothing else.
create or replace function get_feed(p_slug text) returns jsonb
language plpgsql security definer stable
set search_path = public, pg_temp
as $$
declare
  v_company companies%rowtype;
  v_result  jsonb;
begin
  select * into v_company from companies where slug = p_slug;
  if not found then
    raise exception 'unknown slug %', p_slug using errcode = 'no_data_found';
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

-- Log an anonymous sales-page swipe: append to swipe_events and upsert the
-- current decision row (member_id null).
create or replace function log_swipe(p_slug text, p_card_key text, p_action text) returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
  v_card_id    uuid;
begin
  if p_action not in ('like','pass','save','fasttrack') then
    raise exception 'invalid action %', p_action using errcode = 'invalid_parameter_value';
  end if;

  select id into v_company_id from companies where slug = p_slug;
  if v_company_id is null then
    raise exception 'unknown slug %', p_slug using errcode = 'no_data_found';
  end if;

  select id into v_card_id from cards
    where company_id = v_company_id and card_key = p_card_key;
  if v_card_id is null then
    raise exception 'unknown card_key % for slug %', p_card_key, p_slug
      using errcode = 'no_data_found';
  end if;

  insert into swipe_events (company_id, card_id, member_id, action, source)
    values (v_company_id, v_card_id, null, p_action, 'sales');

  insert into decisions (company_id, card_id, member_id, action, updated_at)
    values (v_company_id, v_card_id, null, p_action, now())
  on conflict (company_id, card_id, member_id) do update
    set action = excluded.action, updated_at = now();
end;
$$;

grant execute on function log_swipe(text, text, text) to anon, authenticated;

-- Save an approval and pre-create the articles that will result.
-- The free pick + every other direction slot become 'approved_unwritten' rows.
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
  v_free_card_id   uuid;
  v_direction_ids  uuid[] := '{}';
  v_key            text;
  v_id             uuid;
  v_approval_id    uuid;
  v_deliver_by     timestamptz := now() + interval '24 hours';
  v_normalized     text;
begin
  select id into v_company_id from companies where slug = p_slug;
  if v_company_id is null then
    raise exception 'unknown slug %', p_slug using errcode = 'no_data_found';
  end if;

  select id into v_free_card_id from cards
    where company_id = v_company_id and card_key = p_free_card_key;
  if v_free_card_id is null then
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
    values (v_company_id, v_free_card_id, v_direction_ids, v_normalized, v_deliver_by)
    returning id into v_approval_id;

  -- Materialize an article row for every direction card (the free one included).
  -- Use the partial-unique index to skip duplicates if the client resubmits.
  insert into articles (company_id, card_id, format, title, status)
    select v_company_id, c.id, c.format, c.title, 'approved_unwritten'
    from cards c
    where c.company_id = v_company_id
      and c.id = any(v_direction_ids)
      and not exists (
        select 1 from articles a
        where a.company_id = v_company_id and a.card_id = c.id
      );

  return v_approval_id;
end;
$$;

grant execute on function submit_approval(text, text, text[], text) to anon, authenticated;

-- Spots left = 10 minus the count of active-subscription companies.
create or replace function spots_left() returns int
language sql security definer stable
set search_path = public, pg_temp
as $$
  select greatest(
    0,
    10 - (select count(*)::int from companies where subscription_status = 'active')
  );
$$;

grant execute on function spots_left() to anon, authenticated;
