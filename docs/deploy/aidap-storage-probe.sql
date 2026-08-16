-- AIDAP/Supabase Storage compatibility probe.
-- Run once in the empty laixue-migration-dev AIDAP Studio SQL Editor.
-- Creates only the public test bucket aidap-probe-assets and two narrow
-- anon policies for that bucket. It does not touch production storage.

insert into storage.buckets (id, name, public)
values ('aidap-probe-assets', 'aidap-probe-assets', true);

create policy "aidap_probe_anon_read"
on storage.objects
for select
to anon
using (bucket_id = 'aidap-probe-assets');

create policy "aidap_probe_anon_upload"
on storage.objects
for insert
to anon
with check (bucket_id = 'aidap-probe-assets');
