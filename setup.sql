-- food-log Supabase setup
-- Project: budget-2026 (hpiyvnfhoqnnnotrmwaz) — same project as workout-tracker.
-- The Storage bucket `food-photos` was created via the Storage API at build
-- time. This file applies the DB-side bits the service-role REST endpoint
-- cannot reach without superuser access.
--
-- Run in Supabase SQL editor:
-- https://app.supabase.com/project/hpiyvnfhoqnnnotrmwaz/sql

-- 1) Table -------------------------------------------------------------------

create table if not exists public.food_entries (
  id uuid primary key default gen_random_uuid(),
  eaten_at timestamptz not null default now(),
  photo_path text not null,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists food_entries_eaten_at_idx
  on public.food_entries (eaten_at desc);

-- 2) Row-level security (anon read + write — single-user app, mirrors
--    workout-tracker / budget treatment) -------------------------------------

alter table public.food_entries enable row level security;

drop policy if exists "anon read"   on public.food_entries;
drop policy if exists "anon insert" on public.food_entries;
drop policy if exists "anon delete" on public.food_entries;
drop policy if exists "anon update" on public.food_entries;

create policy "anon read"   on public.food_entries for select using (true);
create policy "anon insert" on public.food_entries for insert with check (true);
create policy "anon update" on public.food_entries for update using (true) with check (true);
create policy "anon delete" on public.food_entries for delete using (true);

-- 3) Storage bucket RLS ------------------------------------------------------
-- The bucket itself is marked PUBLIC (read), but writes/deletes still go
-- through storage.objects RLS. Open it up for the single-user anon key.

drop policy if exists "anon read food-photos"   on storage.objects;
drop policy if exists "anon write food-photos"  on storage.objects;
drop policy if exists "anon update food-photos" on storage.objects;
drop policy if exists "anon delete food-photos" on storage.objects;

create policy "anon read food-photos"
  on storage.objects for select
  using (bucket_id = 'food-photos');

create policy "anon write food-photos"
  on storage.objects for insert
  with check (bucket_id = 'food-photos');

create policy "anon update food-photos"
  on storage.objects for update
  using (bucket_id = 'food-photos')
  with check (bucket_id = 'food-photos');

create policy "anon delete food-photos"
  on storage.objects for delete
  using (bucket_id = 'food-photos');
