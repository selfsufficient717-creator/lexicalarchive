-- Run once in the Supabase SQL editor. No service-role key is used in the browser or API.
-- Subsequent runs are safe for this schema. Inspect any existing tables before applying.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Learner' check (char_length(display_name) between 1 and 80),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2048),
  created_at timestamptz not null default now()
);

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 70000),
  review jsonb not null default '{}'::jsonb check (jsonb_typeof(review) = 'object' and octet_length(review::text) <= 4000),
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create index if not exists items_user_created on public.items(user_id, created_at desc);

create table if not exists public.attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null,
  mode text not null check (mode in ('writing', 'speaking')),
  attempt_number integer not null check (attempt_number between 1 and 3),
  prompt text not null check (char_length(prompt) between 1 and 2500),
  response text not null check (char_length(response) <= 20000),
  feedback jsonb not null check (jsonb_typeof(feedback) = 'object' and octet_length(feedback::text) <= 70000),
  created_at timestamptz not null default now(),
  foreign key (item_id, user_id) references public.items(id, user_id) on delete cascade,
  unique (item_id, mode, attempt_number)
);
create index if not exists attempts_user_item on public.attempts(user_id, item_id, mode);

alter table public.profiles enable row level security;
alter table public.items enable row level security;
alter table public.attempts enable row level security;

revoke all on public.profiles, public.items, public.attempts from anon, public;
revoke all on public.profiles, public.items, public.attempts from authenticated;
grant select, insert, update, delete on public.profiles, public.items to authenticated;
-- Attempts cannot be edited or deleted individually, so revisions stay capped at three.
-- Deleting a collection item also removes its own attempt history through the FK.
grant select, insert on public.attempts to authenticated;

drop policy if exists lexical_profiles_select on public.profiles;
create policy lexical_profiles_select on public.profiles for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists lexical_profiles_insert on public.profiles;
create policy lexical_profiles_insert on public.profiles for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists lexical_profiles_update on public.profiles;
create policy lexical_profiles_update on public.profiles for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists lexical_profiles_delete on public.profiles;
create policy lexical_profiles_delete on public.profiles for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists lexical_items_select on public.items;
create policy lexical_items_select on public.items for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists lexical_items_insert on public.items;
create policy lexical_items_insert on public.items for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists lexical_items_update on public.items;
create policy lexical_items_update on public.items for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists lexical_items_delete on public.items;
create policy lexical_items_delete on public.items for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists lexical_attempts_select on public.attempts;
create policy lexical_attempts_select on public.attempts for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists lexical_attempts_insert on public.attempts;
create policy lexical_attempts_insert on public.attempts for insert to authenticated with check ((select auth.uid()) = user_id);

-- Serialize attempts per item/activity in the database, including concurrent API instances.
-- SECURITY INVOKER preserves the caller's RLS. This is not a service-role bypass.
create or replace function public.lexical_check_attempt()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  last_number integer;
  original_prompt text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.item_id::text || ':' || new.mode, 0));
  select coalesce(max(attempt_number), 0) into last_number
    from public.attempts where item_id = new.item_id and mode = new.mode and user_id = new.user_id;
  if last_number >= 3 or new.attempt_number <> last_number + 1 then
    raise exception 'An initial response and two revisions are allowed in sequence.' using errcode = '23514';
  end if;
  select prompt into original_prompt from public.attempts
    where item_id = new.item_id and mode = new.mode and user_id = new.user_id and attempt_number = 1;
  if original_prompt is not null and new.prompt <> original_prompt then
    raise exception 'A revision must use the original practice prompt.' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists lexical_attempt_window on public.attempts;
create trigger lexical_attempt_window before insert on public.attempts for each row execute function public.lexical_check_attempt();

create or replace function public.lexical_create_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function public.lexical_create_profile() from public, anon, authenticated;
drop trigger if exists lexical_profile_on_signup on auth.users;
create trigger lexical_profile_on_signup after insert on auth.users for each row execute function public.lexical_create_profile();
insert into public.profiles(user_id) select id from auth.users on conflict (user_id) do nothing;

-- Avatars are public profile pictures: explain this before upload in the UI.
-- Private vocabulary, written responses and transcripts remain protected by RLS.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists lexical_avatars_read on storage.objects;
create policy lexical_avatars_read on storage.objects for select to anon, authenticated using (bucket_id = 'avatars');
drop policy if exists lexical_avatars_insert on storage.objects;
create policy lexical_avatars_insert on storage.objects for insert to authenticated with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists lexical_avatars_update on storage.objects;
create policy lexical_avatars_update on storage.objects for update to authenticated using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text) with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists lexical_avatars_delete on storage.objects;
create policy lexical_avatars_delete on storage.objects for delete to authenticated using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
