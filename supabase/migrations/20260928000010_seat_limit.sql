-- ---------------------------------------------------------------------------
-- Seats per company come from data: companies.seat_limit (default 3). The
-- members trigger, invite-member and the portal all read it. A company can
-- be given an extra seat (for example a temporary test seat) by raising it,
-- then lowered back once that seat is removed.
-- ---------------------------------------------------------------------------
alter table companies add column if not exists seat_limit int not null default 3;
alter table companies drop constraint if exists companies_seat_limit_range;
alter table companies add constraint companies_seat_limit_range check (seat_limit between 1 and 10);

create or replace function enforce_max_members() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare v_limit int;
begin
  select seat_limit into v_limit from companies where id = new.company_id;
  if (select count(*) from members where company_id = new.company_id) >= coalesce(v_limit, 3) then
    raise exception 'company % already has % members', new.company_id, coalesce(v_limit, 3)
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
