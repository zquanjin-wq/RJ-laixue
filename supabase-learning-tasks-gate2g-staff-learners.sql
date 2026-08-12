-- Gate 2G: teachers and administrators are also learning participants.
-- Run in Supabase SQL Editor. Safe to re-run.

create or replace function public.sync_staff_learning_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if new.role not in ('teacher', 'admin') then
    return new;
  end if;

  select email into v_email from auth.users where id = new.id;
  if v_email is null then return new; end if;

  insert into public.students (name, email, user_id, disabled_at)
  values (
    coalesce(nullif(trim(new.display_name), ''), split_part(v_email, '@', 1)),
    v_email,
    new.id,
    new.disabled_at
  )
  on conflict (user_id) where user_id is not null do update
    set name = excluded.name,
        disabled_at = excluded.disabled_at,
        updated_at = now();

  return new;
end;
$$;

drop trigger if exists sync_staff_learning_identity on public.profiles;
create trigger sync_staff_learning_identity
after insert or update of role, display_name, disabled_at on public.profiles
for each row execute function public.sync_staff_learning_identity();

-- Backfill existing teacher and administrator accounts.
insert into public.students (name, email, user_id, disabled_at)
select
  coalesce(nullif(trim(p.display_name), ''), split_part(u.email, '@', 1)),
  u.email,
  p.id,
  p.disabled_at
from public.profiles p
join auth.users u on u.id = p.id
where p.role in ('teacher', 'admin')
on conflict (user_id) where user_id is not null do update
  set name = excluded.name,
      disabled_at = excluded.disabled_at,
      updated_at = now();
