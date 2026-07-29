-- supabase-runtime-store-v1.sql
-- RuntimeStore 服务端化（R1）：runtime_sessions / runtime_records + rpc 函数集。
-- 设计依据：docs/reports/2026-07-28-runtimestore-server-r0-design.md（已拍板）
--
-- 关键决策记录：
--   * learner_key 为 text 而非 uuid——RuntimeStore 契约允许任意非空字符串
--     （匿名 access-code 学员的 key 形如 'anon:...'），learnerKey=auth.uid()
--     的强制在 API 层完成，不在列类型上。
--   * 全部语言为 language sql（非 plpgsql）：私有化部署可审计、pg-mem 契约
--     测试可执行同一份 SQL。
--   * seq 由 sessions 行的 next_seq 计数器分配（UPDATE 行锁串行化并发
--     append），不做 max(seq) 扫描。
--   * 可选锚点字段用哨兵值传参（'' / -1 = 缺省），函数内转 NULL；
--     payload 以 text 传 JSON.stringify 结果，函数内 ::jsonb——
--     契约上 payload:null 落库为 jsonb 'null'，与 SQL NULL 可区分。
--   * RLS 仅为防御纵深：生产路径走 service role（绕过 RLS），主授权在
--     API 层（api-guard + 应用层判定）。不开任何教师例外策略。
--
-- 适用：Supabase SQL Editor 一次性执行；私有化 Postgres 同样可执行
-- （除 RLS 段使用 auth.uid()，私有化时按 R0 第 6 节替换 claims 来源）。

-- ── 表 ─────────────────────────────────────────────────────────────

create table if not exists runtime_sessions (
  id                  text        primary key,
  runtime_dsl_version text        not null,  -- semver 'x.y.z'（如 '0.1.0'）；顺序比较
                                           -- 在 TS 层（@openmaic/dsl），SQL 只做相等 CAS
  kind                text        not null,
  stage_id            text        not null,
  learner_key         text        not null,
  status              text        not null
                      check (status in ('active','completed','archived')),
  created_at          timestamptz not null,
  updated_at          timestamptz not null,
  -- 内部计数器：该会话下一条 record 的 seq。不进契约、不暴露给客户端。
  next_seq            integer     not null default 0
);

create index if not exists runtime_sessions_by_stage_learner
  on runtime_sessions (stage_id, learner_key, created_at, id);
create index if not exists runtime_sessions_by_learner
  on runtime_sessions (learner_key);
create index if not exists runtime_sessions_by_stage
  on runtime_sessions (stage_id);

create table if not exists runtime_records (
  session_id   text        not null references runtime_sessions(id) on delete cascade,
  seq          integer     not null,
  id           text        not null,
  scene_id     text,
  action_index integer,
  sub_anchor   text,
  created_at   timestamptz not null,
  payload      jsonb       not null,  -- jsonb 'null' 是合法值（契约允许 payload:null）
  primary key (session_id, seq)
);

-- 幂等键：同一 record id 全局唯一，弱网重试去重（RJ-contract-v1 强化，
-- browser 后端无此约束，契约测试不受影响）。
create unique index if not exists runtime_records_id_unique on runtime_records (id);
create index if not exists runtime_records_by_session_scene
  on runtime_records (session_id, scene_id) where scene_id is not null;

-- ── RLS（防御纵深）─────────────────────────────────────────────────

alter table runtime_sessions enable row level security;
alter table runtime_records  enable row level security;

drop policy if exists runtime_sessions_self on runtime_sessions;
create policy runtime_sessions_self on runtime_sessions
  for all using (learner_key = auth.uid()::text)
  with check (learner_key = auth.uid()::text);

drop policy if exists runtime_records_self on runtime_records;
create policy runtime_records_self on runtime_records
  for all using (
    exists (select 1 from runtime_sessions s
            where s.id = session_id and s.learner_key = auth.uid()::text)
  );

-- ── rpc 函数集（RJ-contract-v1 的服务端实现）────────────────────────
-- outcome 词表：
--   create: 'ok' | 'conflict'
--   update: 'ok' | 'no_session' | 'conflict'（乐观 CAS 失败）
--   append: 'ok' | 'no_session' | 'future_version' | 'inactive_session' | 'id_conflict'
--   merge:  >=0 移动数 | -1 未来版本守护
-- 版本戳由调用方（TS 层，import 自 @openmaic/dsl）作为参数传入——
-- SQL 不硬编码版本号，客户端/服务端同源。

create or replace function runtime_create_session(
  p_id text, p_version text, p_kind text, p_stage_id text, p_learner_key text,
  p_status text, p_created_at text, p_updated_at text
) returns text language sql as $$
with ins as (
  insert into runtime_sessions (id, runtime_dsl_version, kind, stage_id, learner_key, status, created_at, updated_at)
  select p_id, p_version, p_kind, p_stage_id, p_learner_key, p_status,
         p_created_at::timestamptz, p_updated_at::timestamptz
  where not exists (select 1 from runtime_sessions s where s.id = p_id)
  returning id
)
select case when exists (select 1 from ins) then 'ok' else 'conflict' end
$$;

create or replace function runtime_get_session(p_id text)
returns table(id text, runtime_dsl_version text, kind text, stage_id text,
              learner_key text, status text, created_at timestamptz,
              updated_at timestamptz, next_seq integer)
language sql as $$
  select s.id, s.runtime_dsl_version, s.kind, s.stage_id, s.learner_key,
         s.status, s.created_at, s.updated_at, s.next_seq
  from runtime_sessions s where s.id = p_id
$$;

create or replace function runtime_list_sessions(p_stage_id text, p_learner_key text)
returns table(id text, runtime_dsl_version text, kind text, stage_id text,
              learner_key text, status text, created_at timestamptz,
              updated_at timestamptz, next_seq integer)
language sql as $$
  select s.id, s.runtime_dsl_version, s.kind, s.stage_id, s.learner_key,
         s.status, s.created_at, s.updated_at, s.next_seq
  from runtime_sessions s
  where s.stage_id = p_stage_id and s.learner_key = p_learner_key
  order by s.created_at asc, s.id asc
$$;

-- mergeLearner 的 TS 前置守护用：列出一个 learner 跨所有 stage 的会话
create or replace function runtime_list_sessions_by_learner(p_learner_key text)
returns table(id text, runtime_dsl_version text, kind text, stage_id text,
              learner_key text, status text, created_at timestamptz,
              updated_at timestamptz, next_seq integer)
language sql as $$
  select s.id, s.runtime_dsl_version, s.kind, s.stage_id, s.learner_key,
         s.status, s.created_at, s.updated_at, s.next_seq
  from runtime_sessions s
  where s.learner_key = p_learner_key
  order by s.created_at asc, s.id asc
$$;

-- 整行乐观 CAS 更新：TS 层读出行 →（必要时迁移）→ 校验信封 → 以读到的
-- 版本号为 p_expect_version 写回。并发改动导致 'conflict'，调用方重试。
create or replace function runtime_update_session(
  p_id text, p_version text, p_kind text, p_stage_id text, p_learner_key text,
  p_status text, p_created_at text, p_updated_at text, p_expect_version text
) returns text language sql as $$
with cur as (select s.id, s.runtime_dsl_version from runtime_sessions s where s.id = p_id),
upd as (
  update runtime_sessions set
    runtime_dsl_version = p_version, kind = p_kind, stage_id = p_stage_id,
    learner_key = p_learner_key, status = p_status,
    created_at = p_created_at::timestamptz, updated_at = p_updated_at::timestamptz
  where id = p_id and runtime_dsl_version = p_expect_version
  returning id
)
select case
  when not exists (select 1 from cur) then 'no_session'
  when exists (select 1 from upd) then 'ok'
  else 'conflict' end
$$;

create or replace function runtime_append_record(
  p_session_id text, p_id text, p_scene_id text, p_action_index integer,
  p_sub_anchor text, p_created_at text, p_payload text, p_expect_version text
) returns text language sql as $$
with cur as (
  select s.id, s.runtime_dsl_version, s.status from runtime_sessions s where s.id = p_session_id
),
upd as (
  -- UPDATE 行锁使同会话并发 append 串行化；READ COMMITTED 下等待方在
  -- 锁释放后基于已提交的新行重新求值，两个并发 append 拿到不同 seq。
  -- 版本守护是相等 CAS（semver 顺序比较在 TS 层）：预读版本与此处不一致
  -- 说明有并发写或版本漂移，返回 'version_conflict' 由 TS 重读后裁决。
  update runtime_sessions set next_seq = next_seq + 1
  where id = p_session_id
    and runtime_dsl_version = p_expect_version
    and status = 'active'
    -- 幂等重试不消耗 seq（重放同一 record id 时整个 upd 为空）
    and not exists (select 1 from runtime_records r where r.id = p_id)
  returning next_seq as seq
),
ins as (
  insert into runtime_records (session_id, seq, id, scene_id, action_index, sub_anchor, created_at, payload)
  select p_session_id, upd.seq - 1, p_id,
         case when p_scene_id = '' then null else p_scene_id end,
         case when p_action_index = -1 then null else p_action_index end,
         case when p_sub_anchor = '' then null else p_sub_anchor end,
         p_created_at::timestamptz, p_payload::jsonb
  from upd
  returning id
)
select case
    when not exists (select 1 from cur) then 'no_session'
    when exists (select 1 from ins) then 'ok'
    -- 幂等重放优先于状态/版本判定：已落库的 record 重放应幂等成功，
    -- 即使会话此后已 completed（outbox 延迟 flush 场景）
    when exists (select 1 from runtime_records r where r.id = p_id) then 'id_conflict'
    when (select c.status from cur c) <> 'active' then 'inactive_session'
    else 'version_conflict' end
$$;

create or replace function runtime_list_records(p_session_id text)
returns table(session_id text, seq integer, id text, scene_id text,
              action_index integer, sub_anchor text, created_at timestamptz, payload jsonb)
language sql as $$
  select r.session_id, r.seq, r.id, r.scene_id, r.action_index, r.sub_anchor,
         r.created_at, r.payload
  from runtime_records r
  where r.session_id = p_session_id
  order by r.seq asc
$$;

create or replace function runtime_list_records_by_scene(p_session_id text, p_scene_id text)
returns table(session_id text, seq integer, id text, scene_id text,
              action_index integer, sub_anchor text, created_at timestamptz, payload jsonb)
language sql as $$
  select r.session_id, r.seq, r.id, r.scene_id, r.action_index, r.sub_anchor,
         r.created_at, r.payload
  from runtime_records r
  where r.session_id = p_session_id and r.scene_id = p_scene_id
  order by r.seq asc
$$;

create or replace function runtime_get_record(p_id text)
returns table(session_id text, seq integer, id text, scene_id text,
              action_index integer, sub_anchor text, created_at timestamptz, payload jsonb)
language sql as $$
  select r.session_id, r.seq, r.id, r.scene_id, r.action_index, r.sub_anchor,
         r.created_at, r.payload
  from runtime_records r where r.id = p_id
$$;

create or replace function runtime_delete_session(p_id text) returns integer language sql as $$
  with del as (delete from runtime_sessions where id = p_id returning id)
  select cast(count(*) as integer) from del
$$;

-- mergeLearner：TS 层先做未来版本守护（semver 比较在 TS）+ 过期版本就地
-- 迁移，然后以 p_expect_version（= 当前 RUNTIME_DSL_VERSION）做相等 CAS。
-- 返回值 = 移动数；若有行的版本不等于 p_expect_version 则该行不动——
-- TS 比对「预读行数 ≠ 移动数」后重试一次再响亮失败。
create or replace function runtime_merge_learner(p_from text, p_to text, p_expect_version text)
returns integer language sql as $$
  with upd as (
    update runtime_sessions set learner_key = p_to
    where learner_key = p_from and runtime_dsl_version = p_expect_version
    returning id
  )
  select cast((select count(*) from upd) as integer)
$$;

create or replace function runtime_delete_learner_runtime(p_stage_id text, p_learner_key text)
returns integer language sql as $$
  with del as (delete from runtime_sessions where stage_id = p_stage_id and learner_key = p_learner_key returning id)
  select cast(count(*) as integer) from del
$$;

create or replace function runtime_delete_stage_runtime(p_stage_id text)
returns integer language sql as $$
  with del as (delete from runtime_sessions where stage_id = p_stage_id returning id)
  select cast(count(*) as integer) from del
$$;

-- ── merge 授权（拍板点①）────────────────────────────────────────────
-- mergeLearner 必须携带 access-code 绑定流程签发的短期授权；客户端自报
-- fromLearnerKey 一律拒绝。授权是一次性 grant 行：由绑定流程（服务端）
-- 写入，merge 路由原子核销（claim）。无 grant = 403。

create table if not exists runtime_merge_grants (
  id               text        primary key,        -- 服务端生成的 grant id
  from_learner_key text        not null,
  to_learner_key   text        not null,           -- 期望的 auth.uid()
  expires_at       timestamptz not null,
  used_at          timestamptz,                    -- 核销时间；null = 未使用
  created_at       timestamptz not null default now()
);

alter table runtime_merge_grants enable row level security;
-- 浏览器/普通角色无任何策略 = 完全不可见；仅 service role（API 层）可读写。

-- 原子核销：匹配 + 未过期 + 未使用 → 标记 used_at 并返回 'ok'；否则 'invalid'。
-- 单语句完成，并发 claim 只有一个能成功（used_at is null 条件的行锁语义）。
create or replace function runtime_claim_merge_grant(
  p_grant_id text, p_from text, p_to text, p_now text
) returns text language sql as $$
  with upd as (
    update runtime_merge_grants set used_at = p_now::timestamptz
    where id = p_grant_id
      and from_learner_key = p_from
      and to_learner_key = p_to
      and used_at is null
      and expires_at > p_now::timestamptz
    returning id
  )
  select case when exists (select 1 from upd) then 'ok' else 'invalid' end
$$;
