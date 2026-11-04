-- ============================================================
-- Stackd — migration 5 (for V0.95)
-- Splits the single daily prop allowance into two separate counters.
-- Run in Supabase: SQL Editor → New query → Run
-- ============================================================

-- Free plan from V0.95:
--   • 3 single-game prop loads per day  → prop_refresh_count  (existing column, reused)
--   • 1 "scan upcoming" per day         → scan_all_count      (new)
-- Both reset together when prop_refresh_date rolls over to a new day.
alter table public.profiles add column if not exists scan_all_count int default 0;

-- Re-grant the user-editable column set to include the new counter.
-- `plan` and the stripe_* columns stay excluded, so the browser still cannot
-- grant itself Pro.
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


-- Reset both counters for a test account (handy while testing the gating):
-- update public.profiles
-- set prop_refresh_count = 0, scan_all_count = 0, prop_refresh_date = null
-- where email = 'you@example.com';


-- ------------------------------------------------------------
-- SAME CAVEAT AS BEFORE: these counters live in columns the browser can write,
-- so a determined user can reset them from the dev console. That is acceptable
-- for now. Real enforcement belongs in the server-side odds proxy once the
-- caching backend exists, where the count is checked before the upstream call
-- is ever made and the client never gets a say.
-- ------------------------------------------------------------
