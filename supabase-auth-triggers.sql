-- ============================================================
-- RJ-laixue · supabase-auth-triggers.sql
-- Stage-one account-system patch.
-- Run AFTER supabase-auth-mvp.sql and supabase-learning-mvp.sql.
-- Idempotent: safe to re-run.
--
-- What this adds on top of the existing MVP:
--   1. handle_new_user() trigger: every signUp auto-creates a profile row
--      (role='learner', display_name from email prefix or user_metadata).
--      Removes the race condition where useAuth lazy-inserts on the client.
--   2. upgrade_seed_admin() trigger: the operator's seed email is auto-promoted
--      to role='admin' on insert. Change the email constant to your own.
-- ============================================================

-- ------------------------------------------------------------
-- 1) handle_new_user: keep profiles in lock-step with auth.users
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_display_name text;
begin
  v_display_name := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'name'), ''),
    split_part(coalesce(new.email, ''), '@', 1)
  );

  insert into public.profiles (id, role, display_name)
  values (new.id, 'learner', v_display_name)
  on conflict (id) do update
    set display_name = coalesce(public.profiles.display_name, excluded.display_name);

  return new;
end;
$$;

drop trigger if exists trg_handle_new_user on auth.users;
create trigger trg_handle_new_user
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- 2) upgrade_seed_admin: promote the operator's seed email to admin
--    Change the constant below to your admin email.
-- ------------------------------------------------------------
do $$
declare
  v_seed_email text := 'jinzengquan@ruijie.com.cn';
begin
  perform set_config('app.seed_admin_email', lower(v_seed_email), false);
end
$$;

create or replace function public.upgrade_seed_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target text;
begin
  v_target := nullif(lower(current_setting('app.seed_admin_email', true)), '');
  if v_target is not null and lower(coalesce(new.email, '')) = v_target then
    update public.profiles
      set role = 'admin'
      where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_upgrade_seed_admin on auth.users;
create trigger trg_upgrade_seed_admin
  after insert on auth.users
  for each row execute function public.upgrade_seed_admin();

-- ------------------------------------------------------------
-- 3) Sanity probes (do not fail the script).
-- ------------------------------------------------------------
do $$
declare
  v_count int;
  v_seed text;
begin
  select count(*) into v_count from public.profiles;
  raise notice 'profiles rows after trigger setup = %', v_count;

  v_seed := coalesce(current_setting('app.seed_admin_email', true), '(unset)');
  raise notice 'seed admin email configured as: %', v_seed;
end
$$;
