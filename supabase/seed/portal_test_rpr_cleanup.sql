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
  -- The two test users by their fixed ids (Sam's email was later changed to
  -- vedikabhasinwork@gmail.com), plus any teammate invited while testing.
  delete from auth.users where id in ('0b7e5a52-2f1c-4c8e-9a61-7f0a1c2b3d01', '0b7e5a52-2f1c-4c8e-9a61-7f0a1c2b3d02')
     or email like 'vedikabhasin+rpr-%@gmail.com';
  delete from members m where m.company_id = v_company
    and not exists (select 1 from auth.users u where u.id = m.user_id);
end $$;
