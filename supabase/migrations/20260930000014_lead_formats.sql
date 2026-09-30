-- ---------------------------------------------------------------------------
-- Lead formats + per-company intro fields. All additive; RPR's rows and the
-- get_feed() output it already receives are unchanged (new keys only).
--
--   * formats: pillar / insight / post (RPR) plus long_form / short_insight /
--     linkedin_post (every other company). The three lead formats map onto
--     the existing colour families on the sales page (/shared/formats.js).
--     The check constraints on cards, articles and pieces accept all six.
--     request_card() accepts all six too so a lead's portal request does not
--     trip on the old list. credit_costs() is untouched (credits are frozen
--     under call mode; a lead format has no credit price yet).
--   * companies.greeting_name  text, null -> the sales page says "Hi there."
--     (RPR keeps "Hi Patrick." through contact_first_name, its row is not
--     touched).
--   * companies.intro_basis    text, null -> RPR's own intro sentence;
--     otherwise "These {N} directions come from {intro_basis}."
--   * cards.format_note        text, stored with the card, never rendered.
--   * get_feed() returns greeting_name + intro_basis; everything else as
--     before.
-- ---------------------------------------------------------------------------

alter table companies add column if not exists greeting_name text;
alter table companies add column if not exists intro_basis   text;
alter table cards     add column if not exists format_note   text;

alter table cards    drop constraint if exists cards_format_check;
alter table cards    add  constraint cards_format_check
  check (format in ('pillar','insight','post','long_form','short_insight','linkedin_post'));

alter table articles drop constraint if exists articles_format_check;
alter table articles add  constraint articles_format_check
  check (format in ('pillar','insight','post','long_form','short_insight','linkedin_post'));

alter table pieces   drop constraint if exists pieces_format_check;
alter table pieces   add  constraint pieces_format_check
  check (format in ('pillar','insight','post','long_form','short_insight','linkedin_post'));

-- ---- request_card: identical to migration 11 except the format list ------
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
  if v_format not in ('pillar','insight','post','long_form','short_insight','linkedin_post') then
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

-- ---- get_feed: two new keys (greeting_name, intro_basis) ------------------
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
    'greeting_name',      v_company.greeting_name,
    'intro_basis',        v_company.intro_basis,
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
