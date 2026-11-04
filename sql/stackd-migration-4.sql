-- ============================================================
-- Stackd — migration 4 (for V0.91)
-- Adds: arbitrage scan trial counter.
-- Run in Supabase: SQL Editor → New query → Run
-- ============================================================

-- Lifetime free arbitrage scans for non-Pro accounts (not a daily reset —
-- it's a trial, so once they're used they're gone until the user upgrades).
alter table public.profiles add column if not exists arb_scans_used int default 0;

-- Re-grant the user-editable column set to include the new counter.
-- `plan` and the stripe_* columns stay excluded, so the browser still can't
-- grant itself Pro.
grant update (
  username,
  home_state,
  favorite_sports,
  favorite_teams,
  prop_refresh_count,
  prop_refresh_date,
  arb_scans_used
) on public.profiles to authenticated;

-- SAME CAVEAT AS THE PROP QUOTA: arb_scans_used is client-writable, so a
-- determined user can reset it from the browser console. Real enforcement
-- belongs in the server-side odds proxy once the caching backend exists,
-- where the count is checked before the upstream call is made.
