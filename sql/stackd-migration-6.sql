-- ============================================================
-- Stackd — migration 6 (for V1.5.3)
-- Developer view flag.
-- Run in Supabase: SQL Editor → New query → Run
-- ============================================================

-- Request diagnostics (cache state, feed usage, per-game scan detail) are
-- useful while building and meaningless to users. This flag decides who sees
-- them.
alter table public.profiles add column if not exists is_dev boolean not null default false;


-- Re-grant the user-editable column set. `is_dev` is deliberately absent, the
-- same way `plan` and the stripe_* columns are: a user cannot switch on the
-- developer view from the browser console, because the browser has no UPDATE
-- privilege on that column at all.
--
-- This is why the flag lives here rather than in a ?debug=1 URL parameter — a
-- URL can be shared, guessed, or found in a screenshot.
grant update (
  username,
  home_state,
  favorite_sports,
  favorite_teams,
  prop_refresh_count,
  prop_refresh_date,
  scan_all_count,
  arb_scans_used
) on public.profiles to authenticated;


-- Turn it on for the developer account.
update public.profiles
set is_dev = true
where email = 'dev.gm.software@gmail.com';


-- Confirm: should list exactly the accounts that are meant to see diagnostics.
select email, username, plan, is_dev
from public.profiles
order by is_dev desc, created_at desc;


-- ------------------------------------------------------------
-- To grant or revoke later:
--   update public.profiles set is_dev = true  where email = '...';
--   update public.profiles set is_dev = false where email = '...';
-- ------------------------------------------------------------
