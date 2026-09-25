-- Removes everything portal_test_rpr.sql created on RPR, plus anything the
-- walkthrough added (notes, portal swipes, a third invited member).
-- Leaves RPR's cards and signal in place; drop dates go back to null.
do $$
declare
  v_company uuid := (select id from companies where slug = 'rpr-k7m2qx');
begin
  delete from notes        where company_id = v_company;
  delete from swipe_events where company_id = v_company;
  delete from decisions    where company_id = v_company;
  delete from articles     where company_id = v_company;
  update cards set drop_date = null where company_id = v_company;
  update companies set hub_unlocked = false where id = v_company;
  -- Test users (and any teammate invited during the walkthrough).
  delete from auth.users where email like 'vedikabhasin+rpr-%@gmail.com';
  delete from members m where m.company_id = v_company
    and not exists (select 1 from auth.users u where u.id = m.user_id);
end $$;
