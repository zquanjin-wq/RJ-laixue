# AIDAP Supabase compatibility probe — 2026-08-16

## Scope

This probe used only the empty `laixue-migration-dev` AIDAP workspace in
Beijing. It did not read from, write to, or reconfigure the production
Supabase project.

## Verified results

| Capability | Result | Evidence |
| --- | --- | --- |
| PostgreSQL DDL and DML | Pass | `public.aidap_probe_items` was created and received a test row. |
| PostgREST with the AIDAP anon key | Pass | Anonymous REST read returned the inserted probe row. |
| RPC | Pass | SQL RPC returned `rpc-ok`; REST RPC returned `sdk-rpc-ok`. |
| Auth | Pass | `/auth/v1/settings` returned 200; an `aidap-probe-…@example.com` test user was auto-confirmed and received an access token. |
| Storage API | Pass | Bucket listing returned 200. |
| Storage anonymous upload | Pass | `aidap-probe-assets/hello.txt` upload returned 200. |
| Storage public download | Pass | Public download returned 200 with `aidap-storage-ok`. |

## Test-only objects retained

- `public.aidap_probe_items`
- `public.aidap_probe_echo(text)`
- Auth user with an `aidap-probe-` email prefix
- Storage bucket `aidap-probe-assets`
- Object `aidap-probe-assets/hello.txt`
- Two storage policies with the `aidap_probe_` prefix

They are intentionally retained until a migration decision is made, so the
result remains inspectable. They are isolated from production resources.

## Conclusion

AIDAP has passed the compatibility test needed for laixue's present
Supabase usage: PostgreSQL, supabase-js/PostgREST-style access, RPC, Email
Auth, and public object storage. This is sufficient to keep it as a viable
domestic, RMB-billed expansion and migration destination.

It is not a reason to cut over immediately: production remains stable on the
current Supabase Free project, and a real cutover still requires a measured
schema/data/auth/storage export, app environment switch, acceptance test, and
rollback window.
