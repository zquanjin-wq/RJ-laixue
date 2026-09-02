-- ============================================================
-- RJ-laixue · supabase-courses-baseline.sql
--
-- Formal baseline migration for public.courses.
--
-- Provenance:
--   The courses table was originally created by hand in the Supabase
--   console and was never captured as a migration file. Later files
--   (supabase-learning-mvp.sql, supabase-courses-owner.sql, RLS waves)
--   only ALTER or add policies on top of it.
--   This file back-fills that gap. Column definitions are taken from a
--   read-only export of the PRODUCTION project (aqmktsagfvkikehynpdw)
--   on 2026-07-31 and are the authoritative description of what
--   production actually runs today.
--
-- Run order:
--   FIRST in the base-schema chain, BEFORE supabase-learning-mvp.sql
--   (which assumes courses already exists).
--
-- Scope notes (deliberate):
--   * created_by stays `text DEFAULT ''` to match production reality.
--     The uuid + FK design in supabase-courses-owner.sql comments is a
--     separate hardening project (requires production data cleansing of
--     '' values) and is intentionally NOT done here. See handoff doc §4.
--   * This file creates the table and its indexes only. RLS enablement
--     and policies come from the subsequent authorized chain files
--     (supabase-rls-tighten-*.sql), so that policy definitions remain
--     in exactly one place.
--   * No data is inserted. Structural baseline only.
--
-- Review points flagged by author (Kimi), 2026-07-31:
--   1. `id` is PRIMARY KEY — confirmed against production 2026-07-31
--      (CONSTRAINT courses_pkey PRIMARY KEY (id)).
--   2. `data jsonb NOT NULL` has no DEFAULT, matching the export;
--      inserts always carry the full document, so no default is needed.
--   3. Indexes (revised per Codex review 2026-07-31): baseline creates
--      only idx_courses_created_at and idx_courses_created_by, matching
--      production. It deliberately does NOT create courses_created_by_idx;
--      supabase-courses-owner.sql later creates that name as the
--      production-accurate partial index (WHERE created_by IS NOT NULL).
--      Creating it here would occupy the name and make the later
--      CREATE INDEX IF NOT EXISTS silently skip, diverging from production.
--      courses_updated_at_idx was dropped (does not exist in production).
-- ============================================================

create table if not exists public.courses (
  id          text        primary key,
  title       text        not null default '',
  topic       text                  default '',
  data        jsonb       not null,
  created_at  timestamptz           default now(),
  updated_at  timestamptz           default now(),
  created_by  text                  default ''
);

comment on table public.courses is
  'Course documents. Baseline back-filled from production export 2026-07-31; created_by intentionally text (UUID hardening deferred, see file header).';

-- Production-matching business indexes (reviewed 2026-07-31).
-- courses_created_by_idx (partial, WHERE created_by IS NOT NULL) is
-- intentionally left to supabase-courses-owner.sql.
create index if not exists idx_courses_created_at
  on public.courses (created_at desc);

create index if not exists idx_courses_created_by
  on public.courses (created_by);
