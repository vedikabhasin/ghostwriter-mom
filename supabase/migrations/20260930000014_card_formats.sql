-- ---------------------------------------------------------------------------
-- The current card formats from the shared formats map, in the database.
--   long_form, short_insight, linkedin_post (current set)
--   pillar, insight, post (kept for cards already in them)
-- Widens the cards and articles format checks and request_card's check, so
-- a prospect page in a new format can be loaded and requested in the portal.
-- pieces and spend_credits keep the three credit-priced formats (credits are
-- frozen; a new format would need a price first).
-- NOT APPLIED to the live project: apply with the release that ships the new
-- prospect pages.
-- ---------------------------------------------------------------------------
create or replace function card_formats() returns text[]
language sql immutable
as $$ select array['pillar','insight','post','long_form','short_insight','linkedin_post']::text[] $$;

alter table cards drop constraint if exists cards_format_check;
alter table cards add constraint cards_format_check check (format = any (card_formats()));
alter table articles drop constraint if exists articles_format_check;
alter table articles add constraint articles_format_check check (format = any (card_formats()));

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
  if not (v_format = any (card_formats())) then
    raise exception 'invalid format %', v_format using errcode = 'invalid_parameter_value';
  end if;

  select * into v_existing from articles
   where company_id = v_card.company_id and card_id = v_card.id;

  if v_existing.id is not null then
    if v_existing.status in ('writing','delivered') then
      raise exception 'card already %', v_existing.status using errcode = 'invalid_parameter_value';
    end if;
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
