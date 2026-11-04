-- ============================================================
-- Stackd — migration 3
-- Adds: favorite sports/teams, daily prop-refresh quota.
-- Run in Supabase: SQL Editor → New query → Run
-- ============================================================

alter table public.profiles add column if not exists favorite_sports text[] default '{}';
alter table public.profiles add column if not exists favorite_teams jsonb default '{}'::jsonb;

-- Daily prop-refresh quota for the free plan. Resets when the date rolls over.
alter table public.profiles add column if not exists prop_refresh_count int default 0;
alter table public.profiles add column if not exists prop_refresh_date date;

-- Migration 2 revoked blanket UPDATE and granted only (username, home_state).
-- Re-grant to include the new user-editable columns. `plan` and the stripe_*
-- columns stay excluded, so the browser still can't grant itself Pro.
grant update (
  username,
  home_state,
  favorite_sports,
  favorite_teams,
  prop_refresh_count,
  prop_refresh_date
) on public.profiles to authenticated;

-- NOTE ON THE QUOTA: because prop_refresh_count is client-writable, a determined
-- user could reset it from the browser console. That's acceptable for now — the
-- real enforcement point is the server-side odds proxy in the caching backend,
-- where the count can be checked before the upstream call is ever made. Until
-- then, treat this as a soft limit, not a hard one.
