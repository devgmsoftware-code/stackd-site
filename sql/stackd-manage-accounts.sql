-- ============================================================
-- Stackd — account management
-- Run in Supabase: SQL Editor → New query → Run
--
-- profiles.plan is the only thing that grants Pro. Migration 2 revoked UPDATE
-- on that column from normal users, so nobody can grant it to themselves from
-- the browser — it has to be done here, where you have elevated rights.
-- ============================================================


-- ── 1. WHO HAS SIGNED UP ───────────────────────────────────
-- Run this first. Friends only appear after they've signed up AND clicked the
-- confirmation link in their email.
select
  email,
  username,
  plan,
  to_char(created_at, 'Mon DD HH24:MI') as joined,
  prop_refresh_count  as searches_today,
  scan_all_count      as scans_today
from public.profiles
order by created_at desc;


-- ── 2. UPGRADE ONE PERSON ──────────────────────────────────
update public.profiles
set plan = 'pro'
where email = 'friend@example.com';


-- ── 3. UPGRADE SEVERAL AT ONCE ─────────────────────────────
-- update public.profiles
-- set plan = 'pro'
-- where email in (
--   'friend1@example.com',
--   'friend2@example.com',
--   'friend3@example.com'
-- );


-- ── 4. UPGRADE EVERYONE WHO HAS SIGNED UP ──────────────────
-- Fine while it's just your test group. Remove this before the site is public,
-- or you'll be handing Pro to strangers.
-- update public.profiles set plan = 'pro' where plan = 'free';


-- ── 5. BACK TO FREE ────────────────────────────────────────
-- Useful for testing what the free tier actually feels like.
-- update public.profiles
-- set plan = 'free'
-- where email = 'friend@example.com';


-- ── 6. RESET SOMEONE'S DAILY LIMITS ────────────────────────
-- Free plan is 3 game searches + 1 full scan per day. This clears both without
-- waiting for midnight.
-- update public.profiles
-- set prop_refresh_count = 0, scan_all_count = 0, prop_refresh_date = null
-- where email = 'friend@example.com';


-- ── 7. SET A MISSING USERNAME ──────────────────────────────
-- Accounts created before usernames existed, or created directly from the
-- Supabase dashboard, have username = null and fall back to showing the email.
-- Usernames are unique case-insensitively, so this fails if it's taken.
-- update public.profiles
-- set username = 'TheirName'
-- where email = 'friend@example.com';


-- ── 8. CONFIRM IT TOOK ─────────────────────────────────────
select email, username, plan from public.profiles order by created_at desc;
