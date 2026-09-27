-- ---------------------------------------------------------------------------
-- credits_grant(): the one way Stripe adds credits (service role only).
-- Idempotent on source_id (checkout session or invoice id). For a plan grant
-- pass p_rollover_cap = 20: carried-over plan credits above 20 expire first.
-- Returns false if this source was already granted.
-- ---------------------------------------------------------------------------
create or replace function credits_grant(
  p_company_id uuid, p_amount int, p_product text, p_source_id text,
  p_expires_at timestamptz, p_rollover_cap int default null
) returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if p_amount <= 0 or p_source_id is null then
    raise exception 'credits_grant: amount and source are required' using errcode = 'invalid_parameter_value';
  end if;
  perform 1 from companies where id = p_company_id for update;
  if not found then raise exception 'credits_grant: unknown company' using errcode = 'no_data_found'; end if;
  if exists (select 1 from credit_ledger where kind = 'grant' and source_id = p_source_id) then
    return false;
  end if;
  if p_rollover_cap is not null then
    perform credits_cap_rollover(p_company_id, p_rollover_cap, p_source_id);
  end if;
  insert into credit_ledger (company_id, delta, kind, product, source_id, expires_at)
    values (p_company_id, p_amount, 'grant', p_product, p_source_id, p_expires_at);
  return true;
end;
$$;
revoke execute on function credits_grant(uuid, int, text, text, timestamptz, int) from public, anon, authenticated;
