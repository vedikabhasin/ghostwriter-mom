-- Advisor fixes: pin search_path on the trigger fn, and keep the RLS helper
-- off the anon API surface (authenticated still needs it for policies).
alter function public.enforce_max_members() set search_path = public, pg_temp;
revoke execute on function public.is_company_member(uuid) from public, anon;
grant execute on function public.is_company_member(uuid) to authenticated;
