-- food-log Supabase setup — v1.6 schema (meals + meal_photos + weight_log)
-- Project: budget-2026 (hpiyvnfhoqnnnotrmwaz) — same project as workout-tracker.
--
-- v1.5 model: a "meal" is the atom. A meal can have a written/voice-to-text
-- description AND/OR 0+ photos. App enforces "at least one of the two" so the
-- DB schema stays simple — no cross-row CHECK / trigger needed.
--
-- v1.6 add: weight_log as a sibling surface (parallel to meals, not a child).
-- Same single-user anon-key RLS pattern. Vibe-first capture (Allison 2026-05-24):
-- weight is one numeric + an optional note + a fuzzy time, default = "Now."
--
-- The Storage bucket `food-photos` was created via the Storage API at build
-- time. This file applies the DB-side bits the service-role REST endpoint
-- cannot reach without superuser access.
--
-- For v1.6+: applied via Supabase Management API (see
-- `reference_supabase_management_api.md`), no SQL-editor paste needed.
--
-- Run in Supabase SQL editor (fallback path only):
-- https://app.supabase.com/project/hpiyvnfhoqnnnotrmwaz/sql

-- 1) Tables ------------------------------------------------------------------

create table if not exists public.meals (
  id uuid primary key default gen_random_uuid(),
  eaten_at timestamptz not null default now(),
  description text,                    -- nullable; she can type / voice-to-text
  created_at timestamptz not null default now()
);

create table if not exists public.meal_photos (
  id uuid primary key default gen_random_uuid(),
  meal_id uuid not null references public.meals(id) on delete cascade,
  photo_path text not null,
  position smallint not null default 0, -- ordering within the meal
  created_at timestamptz not null default now()
);

create index if not exists meals_eaten_at_idx
  on public.meals (eaten_at desc);

create index if not exists meal_photos_meal_id_idx
  on public.meal_photos (meal_id);

-- 2) Row-level security (anon read + write — single-user app, mirrors
--    workout-tracker / budget treatment) -------------------------------------

alter table public.meals       enable row level security;
alter table public.meal_photos enable row level security;

drop policy if exists "anon read"   on public.meals;
drop policy if exists "anon insert" on public.meals;
drop policy if exists "anon update" on public.meals;
drop policy if exists "anon delete" on public.meals;

create policy "anon read"   on public.meals for select using (true);
create policy "anon insert" on public.meals for insert with check (true);
create policy "anon update" on public.meals for update using (true) with check (true);
create policy "anon delete" on public.meals for delete using (true);

drop policy if exists "anon read"   on public.meal_photos;
drop policy if exists "anon insert" on public.meal_photos;
drop policy if exists "anon update" on public.meal_photos;
drop policy if exists "anon delete" on public.meal_photos;

create policy "anon read"   on public.meal_photos for select using (true);
create policy "anon insert" on public.meal_photos for insert with check (true);
create policy "anon update" on public.meal_photos for update using (true) with check (true);
create policy "anon delete" on public.meal_photos for delete using (true);

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

-- 4) v1.6 weight_log — sibling table, mirrors meals' single-user RLS pattern ---

create table if not exists public.weight_log (
  id uuid primary key default gen_random_uuid(),
  measured_at timestamptz not null default now(),
  weight_kg numeric(5,2) not null,
  notes text,                          -- nullable; voice-to-text friendly
  created_at timestamptz not null default now()
);

create index if not exists weight_log_measured_at_idx
  on public.weight_log (measured_at desc);

alter table public.weight_log enable row level security;

drop policy if exists "anon read"   on public.weight_log;
drop policy if exists "anon insert" on public.weight_log;
drop policy if exists "anon update" on public.weight_log;
drop policy if exists "anon delete" on public.weight_log;

create policy "anon read"   on public.weight_log for select using (true);
create policy "anon insert" on public.weight_log for insert with check (true);
create policy "anon update" on public.weight_log for update using (true) with check (true);
create policy "anon delete" on public.weight_log for delete using (true);
