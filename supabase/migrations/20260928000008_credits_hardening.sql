-- ---------------------------------------------------------------------------
-- Advisor follow-up to the credits migration: functions are executable by
-- PUBLIC by default. Portal RPCs are for signed-in members only; the trigger
-- functions are for triggers only.
-- ---------------------------------------------------------------------------
revoke execute on function hub_access(uuid)            from public, anon;
revoke execute on function portal_active(uuid)         from public, anon;
revoke execute on function portal_account(uuid)        from public, anon;
revoke execute on function spend_credits(uuid, text)   from public, anon;
revoke execute on function credit_grants(uuid)         from public, anon;
revoke execute on function credit_balance(uuid)        from public, anon;
revoke execute on function credit_cost(text)           from public, anon;
grant  execute on function hub_access(uuid)            to authenticated;
grant  execute on function portal_active(uuid)         to authenticated;
grant  execute on function portal_account(uuid)        to authenticated;
grant  execute on function spend_credits(uuid, text)   to authenticated;
grant  execute on function credit_grants(uuid)         to authenticated;
grant  execute on function credit_balance(uuid)        to authenticated;
grant  execute on function credit_cost(text)           to authenticated;
revoke execute on function pieces_on_status()          from public, anon, authenticated;
revoke execute on function pieces_after_status()       from public, anon, authenticated;
