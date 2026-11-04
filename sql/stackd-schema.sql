-- ============================================================
-- Stackd — Supabase schema
-- Run this once in Supabase: Project → SQL Editor → New query → Run
-- ============================================================

-- One row per user, extending Supabase's built-in auth.users.
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text not null,
  plan text not null default 'free',              -- 'free' | 'pro' — drives the freemium gating later
  tos_accepted_at timestamptz,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

-- A user can only ever see/edit their own profile row.
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- Auto-create a profile row the moment someone confirms/signs up via auth.users.
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- One row per logged pick.
create table public.ledger_entries (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  created_at timestamptz default now(),
  book text not null,
  legs jsonb not null,                 -- structured leg data (gameId, market, outcomeKey, peak odds, etc.)
  book_comparison jsonb,               -- snapshot of every book compared at pick time
  stake numeric not null,
  american_odds text,
  boost_pct numeric default 0,
  payout numeric not null,
  status text not null default 'pending'   -- 'pending' | 'won' | 'lost' | 'push'
);

alter table public.ledger_entries enable row level security;

-- A user can only ever see/create/update their own ledger rows — this is the real
-- enforcement of "picks are private," done at the database level, not just hidden in the UI.
create policy "ledger_select_own" on public.ledger_entries
  for select using (auth.uid() = user_id);
create policy "ledger_insert_own" on public.ledger_entries
  for insert with check (auth.uid() = user_id);
create policy "ledger_update_own" on public.ledger_entries
  for update using (auth.uid() = user_id);

create index ledger_entries_user_id_idx on public.ledger_entries (user_id);
