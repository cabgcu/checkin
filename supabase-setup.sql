-- ============================================================
-- CAB VIP Check In — Supabase setup for the email template features
--
-- Safe to run on an existing database, and safe to run more than once:
--   * nothing is dropped, deleted, truncated or overwritten
--   * tables/columns are only added if missing (IF NOT EXISTS)
--   * policies are only created if a policy with that name doesn't exist
--   * Row Level Security is NOT switched on or off for any table
--
-- Run it in Supabase → SQL Editor for the check-in project.
-- ============================================================


-- ── 1. Tables & columns the page reads/writes ─────────────────
-- (No-ops if they already exist.)

create table if not exists public.secrets (
    name  text primary key,
    value text
);

alter table public.events add column if not exists banner_url             text;
alter table public.events add column if not exists heading_text           text;
alter table public.events add column if not exists template_subject       text;
alter table public.events add column if not exists template_body          text;
alter table public.events add column if not exists template_staff_subject text;
alter table public.events add column if not exists template_staff_body    text;
alter table public.events add column if not exists template_guest_subject text;
alter table public.events add column if not exists template_guest_body    text;


-- ── 2. Template library + form settings rows in `secrets` ─────
-- The page stores its template library as one row named
-- VIP_EMAIL_TEMPLATES_LIBRARY. These policies let the page read and
-- write ONLY that row — BREVO_API_KEY and any other secret stay
-- read-only exactly as they are today.
-- (Policies only take effect if RLS is enabled on `secrets`; if it's
-- disabled the table is already writable and these are harmless.)

do $$
begin
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'secrets'
                   and policyname = 'vip_templates_library_select') then
        create policy vip_templates_library_select on public.secrets
            for select to anon, authenticated
            using (name = 'VIP_EMAIL_TEMPLATES_LIBRARY');
    end if;

    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'secrets'
                   and policyname = 'vip_templates_library_insert') then
        create policy vip_templates_library_insert on public.secrets
            for insert to anon, authenticated
            with check (name = 'VIP_EMAIL_TEMPLATES_LIBRARY');
    end if;

    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'secrets'
                   and policyname = 'vip_templates_library_update') then
        create policy vip_templates_library_update on public.secrets
            for update to anon, authenticated
            using (name = 'VIP_EMAIL_TEMPLATES_LIBRARY')
            with check (name = 'VIP_EMAIL_TEMPLATES_LIBRARY');
    end if;
end $$;

-- Same narrow access for the sign-up form settings row (VIP_FORMS_CONFIG),
-- which the public sign-up page also needs to read.
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'secrets'
                   and policyname = 'vip_forms_config_select') then
        create policy vip_forms_config_select on public.secrets
            for select to anon, authenticated
            using (name = 'VIP_FORMS_CONFIG');
    end if;

    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'secrets'
                   and policyname = 'vip_forms_config_insert') then
        create policy vip_forms_config_insert on public.secrets
            for insert to anon, authenticated
            with check (name = 'VIP_FORMS_CONFIG');
    end if;

    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'secrets'
                   and policyname = 'vip_forms_config_update') then
        create policy vip_forms_config_update on public.secrets
            for update to anon, authenticated
            using (name = 'VIP_FORMS_CONFIG')
            with check (name = 'VIP_FORMS_CONFIG');
    end if;
end $$;

grant select, insert, update on public.secrets to anon, authenticated;

-- If `secrets` has an auto-numbered id column, inserting the library row
-- also needs access to that column's sequence.
do $$
declare
    seq text;
begin
    for seq in
        select pg_get_serial_sequence('public.secrets', column_name)
        from information_schema.columns
        where table_schema = 'public' and table_name = 'secrets'
          and pg_get_serial_sequence('public.secrets', column_name) is not null
    loop
        execute format('grant usage, select on sequence %s to anon, authenticated', seq);
    end loop;
end $$;


-- ── 3. Storage bucket for banners & template attachments ──────
-- Creates a public bucket named `banners` if it doesn't exist yet.
-- An existing bucket is left untouched.

insert into storage.buckets (id, name, public)
values ('banners', 'banners', true)
on conflict (id) do nothing;

-- If you ALREADY had a private `banners` bucket, uploaded banners won't
-- display in emails until it's public. Uncomment to make it public:
-- update storage.buckets set public = true where id = 'banners';

do $$
begin
    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'banners_public_read') then
        create policy banners_public_read on storage.objects
            for select to anon, authenticated
            using (bucket_id = 'banners');
    end if;

    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'banners_upload') then
        create policy banners_upload on storage.objects
            for insert to anon, authenticated
            with check (bucket_id = 'banners');
    end if;

    -- Banner uploads use upsert, which needs update permission too
    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'banners_update') then
        create policy banners_update on storage.objects
            for update to anon, authenticated
            using (bucket_id = 'banners')
            with check (bucket_id = 'banners');
    end if;
end $$;
