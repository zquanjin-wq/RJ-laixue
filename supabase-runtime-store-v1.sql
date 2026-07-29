-- supabase-runtime-store-v1.sql
-- RuntimeStore 服务端化（R1.1）：runtime_sessions / runtime_records + rpc 函数集。
-- 设计依据：docs/reports/2026-07-28-runtimestore-server-r0-design.md（已拍板）
-- v1.1 修订（2026-07-29，Codex 联合评审修复卡，
-- docs/reports/2026-07-29-runtimestore-r1-concurrency-gap.md）：
--   ① revision bigint 独立并发版本号——DSL 版本不兼任 CAS（P0-1）；
--   ② learner 级协调用 pg_advisory_xact_lock(hashtext(learner_key))——
--      createSession 与 mergeLearner 共用同一把事务级咨询锁（P0-2）。
--      （锁表方案已废弃：PG 的 WITH 子语句共享同一快照、互不可见——
--      「同语句内先建行再锁行」在真实 PG 同样不成立，探针 17 实证；
--      pg-mem 侧由 harness 注册同签名 no-op，并发证据归 live PG 套件。）
--   ③ createSession 改 ON CONFLICT DO NOTHING，并发重复创建稳定映射
--      'conflict'（P0-3）；
--   ④ merge 与 grant 核销合并为单原子函数 runtime_merge_with_grant——
--      grant 无效或版本冲突都不烧 grant；
--   ⑤ 所有函数 REVOKE EXECUTE from public/anon/authenticated——
--      「浏览器不直连」从约定变成数据库层事实。
--
-- 关键决策记录（沿用 v1，仍有效）：
--   * learner_key 为 text 而非 uuid——RuntimeStore 契约允许任意非空字符串，
--     learnerKey=auth.uid() 的强制在 API 层完成；
--   * 全部 language sql（非 plpgsql）：PostgREST 无跨语句事务，多步逻辑在
--     单语句 CTE 内完成；pg-mem 契约测试执行同一份 SQL（并发语义的证据
--     由真实 PG 双连接套件提供，见 tests/runtime-store-pg/live-pg-concurrency）；
--   * 版本戳为 semver text（'0.1.0'）：顺序比较在 TS 层（@openmaic/dsl），
--     SQL 只做相等判断；
--   * seq 由 sessions 行 next_seq 计数器分配；幂等 record 重放不消耗
--     seq 或 revision；
--   * 可选锚点字段用哨兵值传参（'' / -1 = 缺省），payload 以 text 传
--     JSON.stringify 结果（jsonb 'null' 与 SQL NULL 可区分）；
--   * RLS 仅为防御纵深：生产路径走 service role，主授权在 API 层。
--
-- 适用：Supabase SQL Editor 一次性执行；私有化 Postgres 同样可执行
-- （除 RLS 段使用 auth.uid()、GRANT 段使用 service_role 角色名）。

-- ── 表 ─────────────────────────────────────────────────────────────

create table if not exists runtime_sessions (
  id                  text        primary key,
  runtime_dsl_version text        not null,  -- semver 'x.y.z'；只做迁移/未来版本守护
  revision            bigint      not null default 0,  -- 并发版本号：每次真实行写入 +1
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

-- 幂等键：同一 record id 全局唯一，弱网重试去重（RJ-contract-v1 强化）。
create unique index if not exists runtime_records_id_unique on runtime_records (id);
create index if not exists runtime_records_by_session_scene
  on runtime_records (session_id, scene_id) where scene_id is not null;

-- learner 级协调：createSession / mergeLearner / merge_with_grant 都在语句
-- 开头取 pg_advisory_xact_lock(hashtext(learner_key))，使「匿名学员产生数据」
-- 与「绑定登录后合并数据」在数据库层串行化，消除预读计数竞态（P0-2）。
-- hashtext 是 32 位哈希——不同 learner 哈希碰撞只是无谓串行，不损正确性。

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
--   update: 'ok' | 'no_session' | 'conflict'（revision CAS 失败）
--   append: 'ok' | 'no_session' | 'inactive_session' | 'id_conflict' | 'conflict'
--   merge_with_grant: 'invalid_grant' | 'version_conflict' | 'ok:<移动数>'
-- 版本戳由调用方（TS 层，import 自 @openmaic/dsl）作为参数传入——SQL 不
-- 硬编码版本号，客户端/服务端同源。

create or replace function runtime_create_session(
  p_id text, p_version text, p_kind text, p_stage_id text, p_learner_key text,
  p_status text, p_created_at text, p_updated_at text
) returns text language sql as $$
with lock as (
  -- learner 级咨询锁（ins 以 from lock 引用，强制求值）
  select pg_advisory_xact_lock(hashtext(p_learner_key)) as k
),
pre as (
  -- 前置存在性判定必须是命名 CTE（在 ins 之前求值）：最终 SELECT 里直接
  -- 子查询基表在某些执行器下会看到插入后快照，把新鲜插入误判为 conflict
  select 1 as x from runtime_sessions s where s.id = p_id
),
ins as (
  -- not-exists 前置守卫挡住串行重复（不触发 ON CONFLICT 路径）；ON CONFLICT
  -- 只兜并发竞争（等待方锁释放后 not-exists 重评仍为假则不插入）。
  -- 真 PG 下冲突时 returning 为空 → 'conflict'；并发双方恰好一个 'ok'。
  insert into runtime_sessions (id, runtime_dsl_version, kind, stage_id, learner_key, status, created_at, updated_at)
  select p_id, p_version, p_kind, p_stage_id, p_learner_key, p_status,
         p_created_at::timestamptz, p_updated_at::timestamptz
  from lock
  where not exists (select 1 from pre)
  on conflict (id) do nothing
  returning id
)
select case when exists (select 1 from ins) then 'ok' else 'conflict' end
$$;

create or replace function runtime_get_session(p_id text)
returns table(id text, runtime_dsl_version text, revision bigint, kind text,
              stage_id text, learner_key text, status text,
              created_at timestamptz, updated_at timestamptz, next_seq integer)
language sql as $$
  select s.id, s.runtime_dsl_version, s.revision, s.kind, s.stage_id, s.learner_key,
         s.status, s.created_at, s.updated_at, s.next_seq
  from runtime_sessions s where s.id = p_id
$$;

create or replace function runtime_list_sessions(p_stage_id text, p_learner_key text)
returns table(id text, runtime_dsl_version text, revision bigint, kind text,
              stage_id text, learner_key text, status text,
              created_at timestamptz, updated_at timestamptz, next_seq integer)
language sql as $$
  select s.id, s.runtime_dsl_version, s.revision, s.kind, s.stage_id, s.learner_key,
         s.status, s.created_at, s.updated_at, s.next_seq
  from runtime_sessions s
  where s.stage_id = p_stage_id and s.learner_key = p_learner_key
  order by s.created_at asc, s.id asc
$$;

-- mergeLearner 的 TS 前置守护用：列出一个 learner 跨所有 stage 的会话
create or replace function runtime_list_sessions_by_learner(p_learner_key text)
returns table(id text, runtime_dsl_version text, revision bigint, kind text,
              stage_id text, learner_key text, status text,
              created_at timestamptz, updated_at timestamptz, next_seq integer)
language sql as $$
  select s.id, s.runtime_dsl_version, s.revision, s.kind, s.stage_id, s.learner_key,
         s.status, s.created_at, s.updated_at, s.next_seq
  from runtime_sessions s
  where s.learner_key = p_learner_key
  order by s.created_at asc, s.id asc
$$;

-- 整行乐观 CAS 更新：CAS 条件是 revision（每次真实写入递增），不是 DSL 版本。
-- TS 层读出行 →（必要时迁移）→ 校验信封 → 以读到的 revision 写回。
create or replace function runtime_update_session(
  p_id text, p_version text, p_kind text, p_stage_id text, p_learner_key text,
  p_status text, p_created_at text, p_updated_at text, p_expect_revision bigint
) returns text language sql as $$
with cur as (select s.id, s.revision from runtime_sessions s where s.id = p_id),
upd as (
  update runtime_sessions set
    runtime_dsl_version = p_version, kind = p_kind, stage_id = p_stage_id,
    learner_key = p_learner_key, status = p_status,
    created_at = p_created_at::timestamptz, updated_at = p_updated_at::timestamptz,
    revision = revision + 1
  where id = p_id and revision = p_expect_revision
  returning id
)
select case
  when not exists (select 1 from cur) then 'no_session'
  when exists (select 1 from upd) then 'ok'
  else 'conflict' end
$$;

create or replace function runtime_append_record(
  p_session_id text, p_id text, p_scene_id text, p_action_index integer,
  p_sub_anchor text, p_created_at text, p_payload text, p_expect_revision bigint
) returns text language sql as $$
with cur as (
  select s.id, s.revision, s.status from runtime_sessions s where s.id = p_session_id
),
upd as (
  -- UPDATE 行锁使同会话并发 append 串行化；READ COMMITTED 下等待方在锁释放后
  -- 基于已提交的新行重新求值（status / revision 都是新值），两个并发 append
  -- 拿到不同 seq。revision CAS 挡住预读到写入之间的并发改动。
  -- 幂等重放（record id 已存在）时整个 upd 为空：不消耗 seq、不增加 revision。
  update runtime_sessions set next_seq = next_seq + 1, revision = revision + 1
  where id = p_session_id
    and revision = p_expect_revision
    and status = 'active'
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
    -- 幂等重放优先于状态/CAS 判定：已落库的 record 重放应幂等成功，
    -- 即使会话此后已 completed 或已被其他写入推进 revision（outbox 延迟 flush）
    when exists (select 1 from runtime_records r where r.id = p_id) then 'id_conflict'
    when (select c.status from cur c) <> 'active' then 'inactive_session'
    else 'conflict' end
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
  select cast((select count(*) from del) as integer)
$$;

create or replace function runtime_delete_learner_runtime(p_stage_id text, p_learner_key text)
returns integer language sql as $$
  with del as (delete from runtime_sessions where stage_id = p_stage_id and learner_key = p_learner_key returning id)
  select cast((select count(*) from del) as integer)
$$;

create or replace function runtime_delete_stage_runtime(p_stage_id text)
returns integer language sql as $$
  with del as (delete from runtime_sessions where stage_id = p_stage_id returning id)
  select cast((select count(*) from del) as integer)
$$;

-- ── merge 授权（拍板点①）+ 原子 merge（v1.1）────────────────────────
-- mergeLearner 必须携带 access-code 绑定流程签发的短期一次性授权。
-- grant 只能由服务端（绑定流程）写入；RLS 无任何可见策略。

create table if not exists runtime_merge_grants (
  id               text        primary key,
  from_learner_key text        not null,
  to_learner_key   text        not null,           -- 期望的 auth.uid()
  expires_at       timestamptz not null,
  used_at          timestamptz,                    -- 核销时间；null = 未使用
  created_at       timestamptz not null default now()
);

alter table runtime_merge_grants enable row level security;
-- 浏览器/普通角色无任何策略 = 完全不可见；仅 service role（API 层）可读写。

-- store 层 merge（无 grant——grant 是 API 层授权概念，不进 RuntimeStore 契约）。
-- learner 咨询锁 + 版本守护；返回 'version_conflict'（TS 迁移后重试）或 'ok:<n>'。
-- 注意：upd/bad_version 必须引用 lock（exists），否则 PG 可将未被引用的纯
-- SELECT CTE 优化掉，咨询锁根本不会求值。
create or replace function runtime_merge_learner(p_from text, p_to text, p_expect_version text)
returns text language sql as $$
with lock as (
  select pg_advisory_xact_lock(hashtext(p_from)) as k
),
bad_version as (
  select 1 from runtime_sessions s
  where s.learner_key = p_from and s.runtime_dsl_version <> p_expect_version
    and exists (select 1 from lock)
  limit 1
),
upd as (
  update runtime_sessions set learner_key = p_to, revision = revision + 1
  where learner_key = p_from
    and exists (select 1 from lock)
    and not exists (select 1 from bad_version)
  returning id
),
moved as (select cast(count(*) as text) as n from upd)
-- 注：moved 走 cross join——标量子查询嵌在 concat/|| 里有执行器兼容风险
select case
  when exists (select 1 from bad_version) then 'version_conflict'
  else concat('ok:', m.n) end
from moved m
$$;

-- API 层 merge：grant 校验 + 核销与搬移同一原子语句（自包含版——pg-mem 无法
-- 执行「CTE targetlist 内调挥发函数」的组合写法，且自包含版在真 PG 语义等价、
-- 锁引用关系更显式）。三分支：
--   'invalid_grant'    —— grant 不存在/过期/已核销/目标不匹配；不动数据不烧 grant
--   'version_conflict' —— 存在非期望版本行（TS 迁移后重试）；不烧 grant
--   'ok:<n>'           —— 核销 + 搬移 n 行（n 为真实移动数）
create or replace function runtime_merge_with_grant(
  p_grant_id text, p_from text, p_to text, p_expect_version text, p_now text
) returns text language sql as $$
with grant_ok as (
  select g.id from runtime_merge_grants g
  where g.id = p_grant_id and g.from_learner_key = p_from and g.to_learner_key = p_to
    and g.used_at is null and g.expires_at > p_now::timestamptz
),
lock as (
  -- grant 无效时取锁无害（短暂串行）；upd/claim 的 grant 门控在各自 WHERE 里
  select pg_advisory_xact_lock(hashtext(p_from)) as k
),
bad_version as (
  select 1 from runtime_sessions s
  where s.learner_key = p_from and s.runtime_dsl_version <> p_expect_version
    and exists (select 1 from grant_ok)
    and exists (select 1 from lock)
  limit 1
),
claim as (
  -- 核销先行（data-modifying CTE，PG 保证恰好执行一次）；version_conflict
  -- 时不核销，grant 保留供迁移后重试。
  -- 关键可变条件（from/to/未用/未过期）在 UPDATE WHERE 里直接重写一遍——
  -- 这不是冗余：两个请求共用同一 grant 时，等待咨询锁的一方持语句快照，
  -- CTE 里的 grant_ok 仍看见「未使用」；只有 UPDATE 自身的直接条件会在
  -- READ COMMITTED 的 EvalPlanQual 里对最新行版本重检，挡住双重核销
  -- （Codex R1.1 联合评审第 1 条）。IN-CTE 子查询有执行器兼容风险
  -- （探针 18），故用 exists(grant_ok) + 直接列条件。
  update runtime_merge_grants set used_at = p_now::timestamptz
  where id = p_grant_id
    and from_learner_key = p_from
    and to_learner_key = p_to
    and used_at is null
    and expires_at > p_now::timestamptz
    and exists (select 1 from grant_ok)
    and exists (select 1 from lock)
    and not exists (select 1 from bad_version)
  returning id
),
upd as (
  -- 搬移门控只读 claim 的 RETURNING（CTE 输出，快照安全）——绝不能回读
  -- runtime_merge_grants：claim 已改该表，快照不一致的执行器按求值顺序
  -- 会把门控重估为空，导致「核销了却没搬移」（探针 19 实证）。
  -- 依赖方向强制 claim 先于 upd 求值；claim 为空（grant 无效/版本冲突）
  -- 时 upd 必然为空——核销与搬移同生同灭。
  update runtime_sessions set learner_key = p_to, revision = revision + 1
  where learner_key = p_from
    and exists (select 1 from claim)
  returning id
),
moved as (select cast(count(*) as text) as n from upd),
claimed as (
  -- claim 必须被引用——未引用的 CTE 可能被跳过执行（真 PG 对 data-modifying
  -- CTE 有保证，但跨执行器不假设这一点）
  select count(*) as c from claim
)
-- 注1：moved/claimed 走 cross join——标量子查询嵌在 concat/|| 里有执行器兼容风险。
-- 注2：最终分支不得回读 runtime_merge_grants（grant_ok）——claim 已更新该表，
--      快照不一致的执行器会重估出空集而把成功误判为 invalid_grant（探针 19）。
--      用「bad_version 非空 / 核销行数 / 其余」三分支，语义与原判定等价：
--      grant 无效时 bad_version 被 grant_ok 门控为空、核销为空 → 落入 else。
select case
  when exists (select 1 from bad_version) then 'version_conflict'
  when cl.c > 0 then concat('ok:', m.n)
  else 'invalid_grant' end
from moved m, claimed cl
$$;

-- ── EXECUTE 收口（v1.1）─────────────────────────────────────────────
-- 「浏览器不直连」从约定变成数据库层事实：所有 runtime_* 函数仅
-- service_role 可执行。RLS 是第二道防线，这里是第一道。

revoke execute on function runtime_create_session(text,text,text,text,text,text,text,text) from public, anon, authenticated;
revoke execute on function runtime_get_session(text) from public, anon, authenticated;
revoke execute on function runtime_list_sessions(text,text) from public, anon, authenticated;
revoke execute on function runtime_list_sessions_by_learner(text) from public, anon, authenticated;
revoke execute on function runtime_update_session(text,text,text,text,text,text,text,text,bigint) from public, anon, authenticated;
revoke execute on function runtime_append_record(text,text,text,integer,text,text,text,bigint) from public, anon, authenticated;
revoke execute on function runtime_list_records(text) from public, anon, authenticated;
revoke execute on function runtime_list_records_by_scene(text,text) from public, anon, authenticated;
revoke execute on function runtime_get_record(text) from public, anon, authenticated;
revoke execute on function runtime_delete_session(text) from public, anon, authenticated;
revoke execute on function runtime_delete_learner_runtime(text,text) from public, anon, authenticated;
revoke execute on function runtime_delete_stage_runtime(text) from public, anon, authenticated;
revoke execute on function runtime_merge_learner(text,text,text) from public, anon, authenticated;
revoke execute on function runtime_merge_with_grant(text,text,text,text,text) from public, anon, authenticated;

grant execute on function runtime_create_session(text,text,text,text,text,text,text,text) to service_role;
grant execute on function runtime_get_session(text) to service_role;
grant execute on function runtime_list_sessions(text,text) to service_role;
grant execute on function runtime_list_sessions_by_learner(text) to service_role;
grant execute on function runtime_update_session(text,text,text,text,text,text,text,text,bigint) to service_role;
grant execute on function runtime_append_record(text,text,text,integer,text,text,text,bigint) to service_role;
grant execute on function runtime_list_records(text) to service_role;
grant execute on function runtime_list_records_by_scene(text,text) to service_role;
grant execute on function runtime_get_record(text) to service_role;
grant execute on function runtime_delete_session(text) to service_role;
grant execute on function runtime_delete_learner_runtime(text,text) to service_role;
grant execute on function runtime_delete_stage_runtime(text) to service_role;
grant execute on function runtime_merge_learner(text,text,text) to service_role;
grant execute on function runtime_merge_with_grant(text,text,text,text,text) to service_role;
