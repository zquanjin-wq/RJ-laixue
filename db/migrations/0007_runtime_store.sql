CREATE TABLE runtime.runtime_sessions (
  id text PRIMARY KEY,
  runtime_dsl_version text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  kind text NOT NULL,
  stage_id text NOT NULL,
  learner_key text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  next_seq integer NOT NULL DEFAULT 0
);

CREATE INDEX runtime_sessions_stage_learner_idx
  ON runtime.runtime_sessions (stage_id, learner_key, created_at, id);

CREATE TABLE runtime.runtime_records (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES runtime.runtime_sessions(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  scene_id text,
  action_index integer,
  sub_anchor text,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE TABLE runtime.runtime_merge_grants (
  id text PRIMARY KEY,
  from_learner_key text NOT NULL,
  to_learner_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE runtime.runtime_learner_locks (
  learner_key text PRIMARY KEY
);

CREATE FUNCTION runtime.runtime_create_session(
  p_id text, p_version text, p_kind text, p_stage_id text,
  p_learner_key text, p_status text, p_created_at text, p_updated_at text
) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO runtime.runtime_sessions
    (id, runtime_dsl_version, kind, stage_id, learner_key, status, created_at, updated_at)
  VALUES
    (p_id, p_version, p_kind, p_stage_id, p_learner_key, p_status,
     p_created_at::timestamptz, p_updated_at::timestamptz)
  ON CONFLICT (id) DO NOTHING;
  IF FOUND THEN RETURN 'ok'; END IF;
  RETURN 'exists';
END $$;

CREATE FUNCTION runtime.runtime_get_session(p_id text)
RETURNS SETOF runtime.runtime_sessions LANGUAGE sql STABLE AS $$
  SELECT * FROM runtime.runtime_sessions WHERE id = p_id
$$;

CREATE FUNCTION runtime.runtime_list_sessions(p_stage_id text, p_learner_key text)
RETURNS SETOF runtime.runtime_sessions LANGUAGE sql STABLE AS $$
  SELECT * FROM runtime.runtime_sessions
  WHERE stage_id = p_stage_id AND learner_key = p_learner_key
  ORDER BY created_at, id
$$;

CREATE FUNCTION runtime.runtime_list_sessions_by_learner(p_learner_key text)
RETURNS SETOF runtime.runtime_sessions LANGUAGE sql STABLE AS $$
  SELECT * FROM runtime.runtime_sessions
  WHERE learner_key = p_learner_key
  ORDER BY created_at, id
$$;

CREATE FUNCTION runtime.runtime_update_session(
  p_id text, p_version text, p_kind text, p_stage_id text,
  p_learner_key text, p_status text, p_created_at text, p_updated_at text,
  p_expect_revision bigint
) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  UPDATE runtime.runtime_sessions
  SET runtime_dsl_version = p_version,
      kind = p_kind,
      stage_id = p_stage_id,
      learner_key = p_learner_key,
      status = p_status,
      created_at = p_created_at::timestamptz,
      updated_at = p_updated_at::timestamptz,
      revision = revision + 1
  WHERE id = p_id AND revision = p_expect_revision;
  IF FOUND THEN RETURN 'ok'; END IF;
  IF EXISTS (SELECT 1 FROM runtime.runtime_sessions WHERE id = p_id) THEN RETURN 'conflict'; END IF;
  RETURN 'no_session';
END $$;

CREATE FUNCTION runtime.runtime_append_record(
  p_session_id text, p_id text, p_scene_id text, p_action_index integer,
  p_sub_anchor text, p_created_at text, p_payload text, p_expect_revision bigint
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_seq integer;
BEGIN
  IF EXISTS (SELECT 1 FROM runtime.runtime_records WHERE id = p_id) THEN
    RETURN 'id_conflict';
  END IF;
  UPDATE runtime.runtime_sessions
  SET next_seq = next_seq + 1, revision = revision + 1
  WHERE id = p_session_id AND revision = p_expect_revision AND status = 'active'
  RETURNING next_seq - 1 INTO v_seq;
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM runtime.runtime_sessions WHERE id = p_session_id) THEN RETURN 'no_session'; END IF;
    IF EXISTS (SELECT 1 FROM runtime.runtime_sessions WHERE id = p_session_id AND status <> 'active') THEN RETURN 'inactive_session'; END IF;
    RETURN 'conflict';
  END IF;
  INSERT INTO runtime.runtime_records
    (id, session_id, seq, scene_id, action_index, sub_anchor, created_at, payload)
  VALUES
    (p_id, p_session_id, v_seq, NULLIF(p_scene_id, ''), NULLIF(p_action_index, -1),
     NULLIF(p_sub_anchor, ''), p_created_at::timestamptz, p_payload::jsonb);
  RETURN 'ok';
END $$;

CREATE FUNCTION runtime.runtime_list_records(p_session_id text)
RETURNS SETOF runtime.runtime_records LANGUAGE sql STABLE AS $$
  SELECT * FROM runtime.runtime_records WHERE session_id = p_session_id ORDER BY seq
$$;

CREATE FUNCTION runtime.runtime_list_records_by_scene(p_session_id text, p_scene_id text)
RETURNS SETOF runtime.runtime_records LANGUAGE sql STABLE AS $$
  SELECT * FROM runtime.runtime_records
  WHERE session_id = p_session_id AND scene_id = p_scene_id ORDER BY seq
$$;

CREATE FUNCTION runtime.runtime_get_record(p_id text)
RETURNS SETOF runtime.runtime_records LANGUAGE sql STABLE AS $$
  SELECT * FROM runtime.runtime_records WHERE id = p_id
$$;

CREATE FUNCTION runtime.runtime_delete_session(p_id text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM runtime.runtime_sessions WHERE id = p_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

CREATE FUNCTION runtime.runtime_delete_learner_runtime(p_stage_id text, p_learner_key text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM runtime.runtime_sessions WHERE stage_id = p_stage_id AND learner_key = p_learner_key;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

CREATE FUNCTION runtime.runtime_delete_stage_runtime(p_stage_id text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM runtime.runtime_sessions WHERE stage_id = p_stage_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

CREATE FUNCTION runtime.runtime_merge_learner(p_from text, p_to text, p_expect_version text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_count integer;
BEGIN
  INSERT INTO runtime.runtime_learner_locks (learner_key) VALUES (p_from), (p_to)
  ON CONFLICT DO NOTHING;
  PERFORM learner_key FROM runtime.runtime_learner_locks
  WHERE learner_key IN (p_from, p_to) ORDER BY learner_key FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM runtime.runtime_sessions
    WHERE learner_key = p_from AND runtime_dsl_version <> p_expect_version
  ) THEN RETURN 'version_conflict'; END IF;
  UPDATE runtime.runtime_sessions SET learner_key = p_to WHERE learner_key = p_from;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN 'ok:' || v_count::text;
END $$;

CREATE FUNCTION runtime.runtime_merge_with_grant(
  p_grant_id text, p_from text, p_to text, p_expect_version text, p_now text
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_grant runtime.runtime_merge_grants%ROWTYPE; v_result text;
BEGIN
  SELECT * INTO v_grant FROM runtime.runtime_merge_grants WHERE id = p_grant_id FOR UPDATE;
  IF NOT FOUND OR v_grant.used_at IS NOT NULL OR v_grant.expires_at < p_now::timestamptz
     OR v_grant.from_learner_key <> p_from OR v_grant.to_learner_key <> p_to THEN
    RETURN 'invalid_grant';
  END IF;
  v_result := runtime.runtime_merge_learner(p_from, p_to, p_expect_version);
  IF v_result = 'version_conflict' THEN RETURN v_result; END IF;
  UPDATE runtime.runtime_merge_grants SET used_at = p_now::timestamptz WHERE id = p_grant_id;
  RETURN v_result;
END $$;
