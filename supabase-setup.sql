-- ============================================================
-- CAB VIP Check In — Supabase setup for the email template features
--
-- Safe to run on an existing database, and safe to run more than once:
--   * no data is dropped, deleted, truncated or overwritten (only an older
--     version of the live-ticket claim function is replaced)
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


-- ── 4. Live ticket claims (claim.html) ────────────────────────
-- Free tickets that students claim on a public page while supplies last.
--
-- The ticket limit is enforced HERE, inside the database: every claim
-- locks the event's settings row, counts the tickets already claimed and
-- only inserts if they fit. Two people pressing "Claim" at the same
-- moment are handled one after the other, so the total can never go over.
--
-- The optional waiting room (queue) lives in live_ticket_queue. Visitors
-- never touch that table directly — only through the functions below.

alter table public.guests add column if not exists student_id    text;
alter table public.guests add column if not exists live_claim_id uuid;

create table if not exists public.live_ticket_settings (
    event_id          text primary key,
    status            text        not null default 'closed',   -- 'closed' | 'open' | 'auto'
    opens_at          timestamptz,
    closes_at         timestamptz,
    total_tickets     integer     not null default 0,
    per_claim_limit   integer     not null default 1,
    queue_enabled     boolean     not null default false,
    queue_max_active  integer     not null default 50,         -- people on the form at once
    queue_minutes     integer     not null default 10,         -- time to finish the form
    email_domain      text        not null default '',         -- e.g. my.gcu.edu ('' = any)
    title             text,
    intro             text,
    banner_url        text,
    closed_message    text,
    email_subject     text,
    email_body        text,
    updated_at        timestamptz not null default now()
);

create table if not exists public.live_ticket_queue (
    token        uuid primary key default gen_random_uuid(),
    event_id     text        not null,
    status       text        not null default 'waiting',       -- waiting | active | left | expired | done
    created_at   timestamptz not null default now(),
    admitted_at  timestamptz,
    last_seen    timestamptz not null default now()
);
create index if not exists live_ticket_queue_event_idx on public.live_ticket_queue (event_id, status, created_at);
create index if not exists guests_live_claim_idx on public.guests (live_claim_id) where live_claim_id is not null;

-- Settings: the admin page reads and writes them with the publishable key,
-- like every other admin setting. The queue table gets RLS with no
-- policies, so it's only reachable through the functions below.
alter table public.live_ticket_settings enable row level security;
alter table public.live_ticket_queue    enable row level security;

do $$
begin
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'live_ticket_settings'
                   and policyname = 'live_ticket_settings_select') then
        create policy live_ticket_settings_select on public.live_ticket_settings
            for select to anon, authenticated using (true);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'live_ticket_settings'
                   and policyname = 'live_ticket_settings_insert') then
        create policy live_ticket_settings_insert on public.live_ticket_settings
            for insert to anon, authenticated with check (true);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'live_ticket_settings'
                   and policyname = 'live_ticket_settings_update') then
        create policy live_ticket_settings_update on public.live_ticket_settings
            for update to anon, authenticated using (true) with check (true);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'live_ticket_settings'
                   and policyname = 'live_ticket_settings_delete') then
        create policy live_ticket_settings_delete on public.live_ticket_settings
            for delete to anon, authenticated using (true);
    end if;
end $$;

grant select, insert, update, delete on public.live_ticket_settings to anon, authenticated;

-- Is the claim page open right now? (server clock, so nobody can get in early)
create or replace function public.live_ticket_is_open(s public.live_ticket_settings)
returns text language sql stable as $$
    select case
        when s.status = 'open' then 'open'
        when s.status <> 'auto' then 'closed'
        when s.opens_at is not null and now() < s.opens_at then 'not_yet'
        when s.closes_at is not null and now() >= s.closes_at then 'ended'
        else 'open'
    end
$$;

create or replace function public.live_ticket_claimed(p_event_id text)
returns integer language sql stable security definer set search_path = public as $$
    select count(*)::int from public.guests
    where event_id::text = p_event_id and live_claim_id is not null
$$;

-- Called by claim.html when it loads and then every few seconds.
-- Returns the page settings, tickets left, and (when the waiting room is
-- on) the visitor's place in line. p_token is the visitor's queue ticket.
create or replace function public.live_ticket_status(p_event_id text, p_token uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    s         public.live_ticket_settings;
    v_state   text;
    v_left    integer;
    v_row     public.live_ticket_queue;
    v_slots   integer;
    v_ahead   integer;
    v_info    jsonb;
    v_expired boolean := false;
begin
    select * into s from public.live_ticket_settings where event_id = p_event_id;
    if not found then
        return jsonb_build_object('state', 'missing');
    end if;

    v_state := public.live_ticket_is_open(s);
    v_left  := greatest(s.total_tickets - public.live_ticket_claimed(p_event_id), 0);
    v_info  := jsonb_build_object(
        'title', s.title, 'intro', s.intro, 'banner_url', s.banner_url,
        'closed_message', s.closed_message, 'email_subject', s.email_subject, 'email_body', s.email_body,
        'email_domain', s.email_domain, 'per_claim_limit', s.per_claim_limit,
        'total', s.total_tickets, 'remaining', v_left,
        'opens_at', s.opens_at, 'closes_at', s.closes_at, 'queue', s.queue_enabled, 'server_now', now());

    if v_state <> 'open' then
        return v_info || jsonb_build_object('state', v_state);
    end if;
    if v_left <= 0 then
        return v_info || jsonb_build_object('state', 'sold_out');
    end if;
    if not s.queue_enabled then
        return v_info || jsonb_build_object('state', 'open');
    end if;

    -- Waiting room: one visitor at a time updates the line for this event
    perform pg_advisory_xact_lock(hashtext('live_ticket_queue:' || p_event_id));

    -- Free up spots: form time used up, or the tab was closed (no check-in for 2 min).
    -- People waiting in line who go quiet for 3 min step out (and keep their place if they come back).
    update public.live_ticket_queue set status = 'expired'
     where event_id = p_event_id and status = 'active'
       and (admitted_at < now() - make_interval(mins => s.queue_minutes) or last_seen < now() - interval '2 minutes');
    update public.live_ticket_queue set status = 'left'
     where event_id = p_event_id and status = 'waiting' and last_seen < now() - interval '3 minutes';

    if p_token is not null then
        select * into v_row from public.live_ticket_queue where token = p_token and event_id = p_event_id;
    end if;
    if v_row.token is null or v_row.status in ('expired', 'done') then
        v_expired := v_row.token is not null and v_row.status = 'expired';
        insert into public.live_ticket_queue (event_id) values (p_event_id) returning * into v_row;
    elsif v_row.status = 'left' then
        update public.live_ticket_queue set status = 'waiting', last_seen = now() where token = v_row.token returning * into v_row;
    else
        update public.live_ticket_queue set last_seen = now() where token = v_row.token returning * into v_row;
    end if;

    -- Let the next people in line onto the form
    select s.queue_max_active - count(*) into v_slots
      from public.live_ticket_queue where event_id = p_event_id and status = 'active';
    if v_slots > 0 then
        update public.live_ticket_queue set status = 'active', admitted_at = now(), last_seen = now()
         where token in (select token from public.live_ticket_queue
                          where event_id = p_event_id and status = 'waiting'
                          order by created_at limit v_slots);
    end if;

    select * into v_row from public.live_ticket_queue where token = v_row.token;
    if v_row.status = 'active' then
        return v_info || jsonb_build_object('state', 'open', 'token', v_row.token,
            'expires_at', v_row.admitted_at + make_interval(mins => s.queue_minutes), 'was_expired', v_expired);
    end if;

    select count(*) into v_ahead from public.live_ticket_queue
     where event_id = p_event_id and status = 'waiting' and created_at < v_row.created_at;
    return v_info || jsonb_build_object('state', 'waiting', 'token', v_row.token,
        'position', v_ahead + 1, 'was_expired', v_expired);
end $$;

-- The claim itself. Everything is checked again here, under a lock, so
-- the ticket limit, the per-person limit and "one ticket per student" hold
-- no matter how many people submit at once.
--
-- p_guests: one entry per extra ticket, each for a different student:
--   [{ "first": "...", "last": "...", "email": "...", "student_id": "..." }, ...]
-- Tickets claimed = 1 (the person filling out the form) + number of guests.
--
-- (Replaces the first version of this function, which took a ticket count.)
drop function if exists public.claim_live_tickets(text, text, text, text, text, text, integer, uuid);

create or replace function public.claim_live_tickets(
    p_event_id text, p_first text, p_last text, p_email text, p_phone text,
    p_student_id text, p_guests jsonb default '[]'::jsonb, p_token uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    s        public.live_ticket_settings;
    v_event  public.events.id%type;
    v_state  text;
    v_left   integer;
    v_claim  uuid := gen_random_uuid();
    v_phone  text := btrim(coalesce(p_phone, ''));
    v_domain text;
    v_people jsonb := '[]'::jsonb;   -- the claimer first, then each guest
    v_p      jsonb;
    v_qty    integer;
    v_first  text;
    v_last   text;
    v_email  text;
    v_sid    text;
    v_host   text;
    v_ids    jsonb := '[]'::jsonb;
    v_id     text;
    i        integer := 0;
begin
    if p_guests is null then p_guests := '[]'::jsonb; end if;
    if jsonb_typeof(p_guests) <> 'array' then
        return jsonb_build_object('ok', false, 'error', 'guests');
    end if;

    v_people := jsonb_build_array(jsonb_build_object(
        'first', btrim(coalesce(p_first, '')), 'last', btrim(coalesce(p_last, '')),
        'email', lower(btrim(coalesce(p_email, ''))), 'student_id', btrim(coalesce(p_student_id, ''))));
    for v_p in select value from jsonb_array_elements(p_guests) loop
        v_people := v_people || jsonb_build_array(jsonb_build_object(
            'first', btrim(coalesce(v_p->>'first', '')), 'last', btrim(coalesce(v_p->>'last', '')),
            'email', lower(btrim(coalesce(v_p->>'email', ''))), 'student_id', btrim(coalesce(v_p->>'student_id', ''))));
    end loop;
    v_qty := jsonb_array_length(v_people);

    -- Everyone needs a name, a valid email and a student ID ('who' = 0 for the claimer, 1+ for guests)
    for v_p in select value from jsonb_array_elements(v_people) loop
        if v_p->>'first' = '' or v_p->>'last' = '' or length(v_p->>'first') > 80 or length(v_p->>'last') > 80 then
            return jsonb_build_object('ok', false, 'error', 'name', 'who', i);
        end if;
        if (v_p->>'email') !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or length(v_p->>'email') > 200 then
            return jsonb_build_object('ok', false, 'error', 'email', 'who', i);
        end if;
        if v_p->>'student_id' = '' or length(v_p->>'student_id') > 40 then
            return jsonb_build_object('ok', false, 'error', 'student_id', 'who', i);
        end if;
        i := i + 1;
    end loop;
    if length(regexp_replace(v_phone, '\D', '', 'g')) < 7 or length(v_phone) > 40 then
        return jsonb_build_object('ok', false, 'error', 'phone', 'who', 0);
    end if;

    -- The same student can't be on one claim twice
    if (select count(distinct x->>'email') from jsonb_array_elements(v_people) x) < v_qty
       or (select count(distinct lower(x->>'student_id')) from jsonb_array_elements(v_people) x) < v_qty then
        return jsonb_build_object('ok', false, 'error', 'same_person');
    end if;

    select id into v_event from public.events where id::text = p_event_id;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'closed');
    end if;

    -- The lock: claims for this event wait here and go through one at a time
    select * into s from public.live_ticket_settings where event_id = p_event_id for update;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'closed');
    end if;

    v_state := public.live_ticket_is_open(s);
    if v_state <> 'open' then
        return jsonb_build_object('ok', false, 'error', 'closed');
    end if;

    v_domain := lower(ltrim(btrim(coalesce(s.email_domain, '')), '@'));
    if v_domain <> '' then
        i := 0;
        for v_p in select value from jsonb_array_elements(v_people) loop
            if right(v_p->>'email', length(v_domain) + 1) <> '@' || v_domain then
                return jsonb_build_object('ok', false, 'error', 'domain', 'domain', v_domain, 'who', i);
            end if;
            i := i + 1;
        end loop;
    end if;

    if v_qty > greatest(s.per_claim_limit, 1) then
        return jsonb_build_object('ok', false, 'error', 'quantity', 'limit', greatest(s.per_claim_limit, 1));
    end if;

    if s.queue_enabled then
        if p_token is null or not exists (
            select 1 from public.live_ticket_queue
             where token = p_token and event_id = p_event_id and status = 'active'
               and admitted_at >= now() - make_interval(mins => s.queue_minutes)) then
            return jsonb_build_object('ok', false, 'error', 'queue');
        end if;
    end if;

    -- One ticket per student: nobody on this claim may already hold a live ticket
    i := 0;
    for v_p in select value from jsonb_array_elements(v_people) loop
        if exists (select 1 from public.guests
                    where event_id::text = p_event_id and live_claim_id is not null
                      and (lower(email) = v_p->>'email' or lower(btrim(student_id)) = lower(v_p->>'student_id'))) then
            return jsonb_build_object('ok', false, 'error', 'duplicate', 'who', i);
        end if;
        i := i + 1;
    end loop;

    v_left := s.total_tickets - public.live_ticket_claimed(p_event_id);
    if v_left <= 0 then
        return jsonb_build_object('ok', false, 'error', 'sold_out', 'remaining', 0);
    end if;
    if v_qty > v_left then
        return jsonb_build_object('ok', false, 'error', 'not_enough', 'remaining', v_left);
    end if;

    v_host := (v_people->0->>'first') || ' ' || (v_people->0->>'last');
    i := 0;
    for v_p in select value from jsonb_array_elements(v_people) loop
        insert into public.guests (event_id, first_name, last_name, email, phone, student_id, team, status, email_sent, live_claim_id)
        values (v_event, v_p->>'first', v_p->>'last', v_p->>'email',
                case when i = 0 then v_phone else null end,
                v_p->>'student_id',
                case when i = 0 then 'Live Tickets' else 'Guest of ' || v_host end,
                'Invited', 'No', v_claim)
        returning id::text into v_id;
        v_ids := v_ids || jsonb_build_object('id', v_id, 'number', i + 1,
            'first', v_p->>'first', 'last', v_p->>'last', 'email', v_p->>'email');
        i := i + 1;
    end loop;

    if p_token is not null then
        update public.live_ticket_queue set status = 'done' where token = p_token;
    end if;

    return jsonb_build_object('ok', true, 'claim_id', v_claim, 'tickets', v_ids, 'remaining', v_left - v_qty);
end $$;

-- Waiting-room numbers for the admin page
create or replace function public.live_ticket_queue_stats(p_event_id text)
returns jsonb language sql stable security definer set search_path = public as $$
    select jsonb_build_object(
        'waiting', count(*) filter (where status = 'waiting' and last_seen >= now() - interval '3 minutes'),
        'active',  count(*) filter (where status = 'active'  and last_seen >= now() - interval '2 minutes'))
    from public.live_ticket_queue where event_id = p_event_id
$$;

-- Admin "Clear the line" button
create or replace function public.live_ticket_queue_reset(p_event_id text)
returns void language sql security definer set search_path = public as $$
    delete from public.live_ticket_queue where event_id = p_event_id
$$;

grant execute on function public.live_ticket_status(text, uuid) to anon, authenticated;
grant execute on function public.claim_live_tickets(text, text, text, text, text, text, jsonb, uuid) to anon, authenticated;
grant execute on function public.live_ticket_queue_stats(text) to anon, authenticated;
grant execute on function public.live_ticket_queue_reset(text) to anon, authenticated;
