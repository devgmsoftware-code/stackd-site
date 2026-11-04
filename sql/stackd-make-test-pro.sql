-- ============================================================
-- Stackd — grant Pro to a test account
-- Run in Supabase: SQL Editor → New query → Run
--
-- The app reads profiles.plan ('free' | 'pro'). Migration 2 revoked UPDATE on
-- that column from normal users, so the browser can't grant itself Pro — but
-- the SQL Editor runs with elevated rights, so this works.
-- ============================================================

-- STEP 1 — see your accounts and what plan each is on.
-- Run this first to confirm the email you want is actually there.
select id, email, username, plan, subscription_status, created_at
from public.profiles
order by created_at desc;


-- STEP 2 — flip one account to Pro. Replace the email below.
-- The account must already exist (signed up + confirmed email) before this runs.
update public.profiles
set plan = 'pro'
where email = 'REPLACE_WITH_YOUR_TEST_EMAIL';

-- Confirm it took:
select email, username, plan from public.profiles
where email = 'REPLACE_WITH_YOUR_TEST_EMAIL';


-- ------------------------------------------------------------
-- Handy extras while testing
-- ------------------------------------------------------------

-- Reset a free account's daily prop loads (normally 5/day):
-- update public.profiles
-- set prop_refresh_count = 0, prop_refresh_date = null
-- where email = 'REPLACE_WITH_YOUR_TEST_EMAIL';

-- Reset the free arbitrage trial scans (normally 3 lifetime):
-- update public.profiles
-- set arb_scans_used = 0
-- where email = 'REPLACE_WITH_YOUR_TEST_EMAIL';

-- Drop back to free, to test the gating/upsell paths from the other side:
-- update public.profiles
-- set plan = 'free'
-- where email = 'REPLACE_WITH_YOUR_TEST_EMAIL';


-- ------------------------------------------------------------
-- NOTE: this sets the plan flag directly and does NOT create a Stripe
-- subscription. That's exactly what you want for testing. But it also means
-- that once the Stripe webhook is live, a real subscription event for this
-- user will overwrite whatever you set here — the webhook is the source of
-- truth for plan. Keep test accounts separate from any account you later
-- run a real checkout on.
-- ------------------------------------------------------------
