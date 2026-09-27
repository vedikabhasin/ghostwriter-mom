-- ---------------------------------------------------------------------------
-- Session A expansion:
--   * companies.is_internal (excluded from spots_left, ignored by webhook)
--   * cards.series (for VB / BlendXR split etc.)
--   * articles.requested_at + articles.deliver_by
--   * hub_items table (Session B builds the UI; Session A can seed it)
--   * spots_left() now excludes internal companies
--   * submit_approval() also stamps requested_at + deliver_by on the free
--     pick's article row so approvals.deliver_by and articles.deliver_by
--     can never disagree
-- Additive — no drops on existing columns.
-- ---------------------------------------------------------------------------

alter table companies add column if not exists is_internal boolean not null default false;
alter table cards     add column if not exists series      text;
alter table articles  add column if not exists requested_at timestamptz;
alter table articles  add column if not exists deliver_by   timestamptz;

-- Hub items live in one canvas per company: text, sticky-note emojis, or
-- pointers to articles / notes. Same membership check as everything else.
create table if not exists hub_items (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  kind        text not null check (kind in ('article','note','text','emoji')),
  ref_id      uuid,                    -- article.id or note.id when kind matches
  body        text,                    -- kind='text' body
  emoji       text,                    -- kind='emoji' glyph
  x           numeric not null default 0,
  y           numeric not null default 0,
  rotation    numeric not null default 0,
  z           int     not null default 0,
  hidden      boolean not null default false,
  created_by  uuid references members(id) on delete set null,   -- null = seeded
  updated_at  timestamptz not null default now()
);
create index if not exists hub_items_company_id_idx on hub_items (company_id);
create index if not exists hub_items_ref_id_idx     on hub_items (ref_id) where ref_id is not null;

alter table hub_items enable row level security;

drop policy if exists hub_items_select on hub_items;
drop policy if exists hub_items_insert on hub_items;
drop policy if exists hub_items_update on hub_items;
drop policy if exists hub_items_delete on hub_items;

create policy hub_items_select on hub_items
  for select to authenticated
  using (is_company_member(company_id));

create policy hub_items_insert on hub_items
  for insert to authenticated
  with check (
    is_company_member(company_id)
    and (created_by is null
         or (select user_id from members where id = created_by) = auth.uid())
  );

create policy hub_items_update on hub_items
  for update to authenticated
  using (is_company_member(company_id))
  with check (is_company_member(company_id));

create policy hub_items_delete on hub_items
  for delete to authenticated
  using (is_company_member(company_id));

-- spots_left(): 10 minus real (non-internal) active companies. Internal
-- companies like Vedika Bhasin don't consume a spot.
create or replace function spots_left() returns int
language sql security definer stable
set search_path = public, pg_temp
as $$
  select greatest(
    0,
    10 - (select count(*)::int
            from companies
           where subscription_status = 'active'
             and is_internal = false)
  );
$$;
grant execute on function spots_left() to anon, authenticated;

-- submit_approval() now stamps requested_at + deliver_by on the free pick's
-- article row, so the approvals row and the article always agree. The other
-- direction cards stay 'approved_unwritten' with no timestamps yet.
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
  v_now            timestamptz := now();
  v_deliver_by     timestamptz := v_now + interval '24 hours';
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

  -- Free pick gets requested_at + deliver_by. Other direction cards land as
  -- approved_unwritten with no timestamps yet — they get one when the client
  -- calls in a credit or the writer starts work.
  insert into articles (company_id, card_id, format, title, status, requested_at, deliver_by)
    select v_company_id, c.id, c.format, c.title, 'approved_unwritten',
           case when c.id = v_free_card_id then v_now       else null end,
           case when c.id = v_free_card_id then v_deliver_by else null end
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

-- get_feed(): unchanged shape, one new field on each card: series (nullable).
-- Internal companies (is_internal = true) return nothing: their /<slug> URL
-- redirects to /portal at the netlify layer, and this guards the RPC in case
-- someone hits it directly with anon.
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
