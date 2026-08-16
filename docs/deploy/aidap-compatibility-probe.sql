-- AIDAP/Supabase minimal compatibility probe.
-- Safe to run repeatedly in the empty laixue-migration-dev workspace.
-- It does not read from or modify the production Supabase project.

create table if not exists public.aidap_probe_items (
  id bigint generated always as identity primary key,
  note text not null,
  created_at timestamptz not null default now()
);

create or replace function public.aidap_probe_echo(input text)
returns text
language sql
stable
as $$ select input $$;

insert into public.aidap_probe_items(note)
values ('aidap compatibility probe')
returning id, note, created_at;

select public.aidap_probe_echo('rpc-ok') as rpc_result;
