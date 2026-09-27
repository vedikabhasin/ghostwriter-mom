-- ---------------------------------------------------------------------------
-- Weekly drop day + per-client scarcity flag + first-open tracking.
-- All additive. Every existing feed keeps working — first_opened_at is null
-- until a visitor sets it, and show_scarcity defaults false so the "10 spots"
-- pill stops rendering by default.
-- ---------------------------------------------------------------------------

alter table companies add column if not exists first_opened_at timestamptz;
alter table companies add column if not exists show_scarcity   boolean not null default false;

-- Stamp the company's first-visit timestamp exactly once. Anon can call it,
-- but it can't overwrite a value that's already set — the guard is in SQL.
-- Returns the resulting timestamp (existing or newly set) so the sales page
-- can compute the drop weekday without a second round-trip.
create or replace function bump_first_opened_at(p_slug text)
returns timestamptz
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_ts timestamptz;
begin
  update companies
     set first_opened_at = now()
   where slug = p_slug
     and first_opened_at is null
   returning first_opened_at into v_ts;

  if v_ts is null then
    -- Either already stamped, or the slug is unknown. Return whatever is set
    -- (may still be null for an unknown slug, which the caller ignores).
    select first_opened_at into v_ts from companies where slug = p_slug;
  end if;

  return v_ts;
end;
$$;

revoke execute on function bump_first_opened_at(text) from public;
grant  execute on function bump_first_opened_at(text) to anon, authenticated;

-- get_feed(): unchanged shape + two new fields (first_opened_at, show_scarcity)
-- and still refuses internal companies. Series stays.
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
