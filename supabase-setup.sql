-- SCRIPTROOM DATABASE + STORAGE SETUP
-- Run this entire file in Supabase Dashboard > SQL Editor > New query.
-- This creates a public-read screenplay library with administrator-only writes.

create extension if not exists pgcrypto;

-- A user is an administrator only when their Auth user ID is listed here.
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Metadata lives in Postgres. The actual PDF files live in Supabase Storage.
create table if not exists public.screenplays (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 100),
  description text not null default '',
  genre text not null default 'Other',
  script_year integer check (script_year is null or script_year between 1900 and 2100),
  file_path text not null unique,
  file_name text not null,
  file_size bigint not null default 0 check (file_size >= 0),
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;
alter table public.screenplays enable row level security;

grant usage on schema public to anon, authenticated;
grant select on public.screenplays to anon, authenticated;
grant insert, update, delete on public.screenplays to authenticated;
grant select on public.admins to authenticated;

-- SECURITY DEFINER lets the policy check the admins table without recursive RLS.
create or replace function public.is_scriptroom_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admins
    where user_id = auth.uid()
  );
$$;

revoke all on function public.is_scriptroom_admin() from public;
grant execute on function public.is_scriptroom_admin() to authenticated;

-- Make this script safe to re-run by replacing the policies it owns.
drop policy if exists "Anyone can read screenplay metadata" on public.screenplays;
drop policy if exists "Admins can add screenplay metadata" on public.screenplays;
drop policy if exists "Admins can update screenplay metadata" on public.screenplays;
drop policy if exists "Admins can delete screenplay metadata" on public.screenplays;
drop policy if exists "Admins can read their own admin row" on public.admins;

create policy "Anyone can read screenplay metadata"
on public.screenplays for select
to anon, authenticated
using (true);

create policy "Admins can add screenplay metadata"
on public.screenplays for insert
to authenticated
with check (public.is_scriptroom_admin());

create policy "Admins can update screenplay metadata"
on public.screenplays for update
to authenticated
using (public.is_scriptroom_admin())
with check (public.is_scriptroom_admin());

create policy "Admins can delete screenplay metadata"
on public.screenplays for delete
to authenticated
using (public.is_scriptroom_admin());

create policy "Admins can read their own admin row"
on public.admins for select
to authenticated
using (user_id = auth.uid());

-- Create the PDF bucket. Public read means anyone can view a screenplay PDF;
-- the RLS policies below still restrict uploads, replacements and deletion.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'screenplays',
  'screenplays',
  true,
  52428800,
  array['application/pdf']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Storage policies are separate from the screenplay table policies.
drop policy if exists "Anyone can list screenplay PDFs" on storage.objects;
drop policy if exists "Admins can upload screenplay PDFs" on storage.objects;
drop policy if exists "Admins can update screenplay PDFs" on storage.objects;
drop policy if exists "Admins can delete screenplay PDFs" on storage.objects;

create policy "Anyone can list screenplay PDFs"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'screenplays');

create policy "Admins can upload screenplay PDFs"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'screenplays'
  and public.is_scriptroom_admin()
);

create policy "Admins can update screenplay PDFs"
on storage.objects for update
to authenticated
using (
  bucket_id = 'screenplays'
  and public.is_scriptroom_admin()
)
with check (
  bucket_id = 'screenplays'
  and public.is_scriptroom_admin()
);

create policy "Admins can delete screenplay PDFs"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'screenplays'
  and public.is_scriptroom_admin()
);

-- AFTER creating your admin user in Supabase Authentication > Users,
-- replace the email below with your own email and run this statement:
-- insert into public.admins (user_id)
-- select id from auth.users where email = 'you@example.com'
-- on conflict (user_id) do nothing;
