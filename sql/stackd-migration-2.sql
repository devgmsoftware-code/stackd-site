-- ============================================================
-- Stackd — migration 2
-- Adds: unique usernames, home-state preference, subscription/plan fields.
-- Run in Supabase: SQL Editor → New query → Run
-- ============================================================

-- Unique username (case-insensitive uniqueness so "Gunit" and "gunit" can't both exist).
alter table public.profiles add column if not exists username text;
create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

-- Which state the user mostly bets in. NULL / 'ALL' = show all books nationwide (the default).
alter table public.profiles add column if not exists home_state text default 'ALL';

-- Subscription state, driven by Stripe webhooks (never written from the browser).
alter table public.profiles add column if not exists stripe_customer_id text;
alter table public.profiles add column if not exists stripe_subscription_id text;
alter table public.profiles add column if not exists subscription_status text;   -- active | trialing | past_due | canceled
alter table public.profiles add column if not exists current_period_end timestamptz;

-- A user may edit their own username/home_state, but must NOT be able to grant
-- themselves a paid plan. Drop the broad update policy and replace it with a
-- column-scoped one; plan/subscription columns are writable only by the
-- service role (i.e. your Stripe webhook function).
drop policy if exists "profiles_update_own" on public.profiles;

create policy "profiles_update_own_safe" on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id);

revoke update on public.profiles from authenticated;
grant update (username, home_state) on public.profiles to authenticated;

-- Public username lookup for future friend-finding: anyone signed in can check
-- whether a username exists, but sees nothing else about that account.
create or replace view public.usernames as
  select username from public.profiles where username is not null;
grant select on public.usernames to authenticated, anon;
