import type { Pool } from 'pg';

export type TaskLearnerAnalyticsRow = {
  student_id: string;
  name: string;
  status: string;
  progress_percent: number;
  mastery_percent: number | null;
  effective_seconds: number;
  last_seen_at: string | null;
};

export type TaskCourseAnalyticsRow = {
  course_id: string;
  position: number;
  is_required: boolean;
  title: string;
  content: unknown;
};

export type TaskCourseProgressRow = {
  task_id: string;
  course_id: string;
  student_id: string;
  status: string;
  progress_percent: number;
  effective_seconds: number;
};

export type TaskLearningEventRow = {
  student_id: string;
  event_type: string;
  scene_id: string | null;
  created_at: string;
};

export class LearningAnalyticsRepository {
  constructor(private readonly pool: Pool) {}

  async getTask(taskId: string) {
    const result = await this.pool.query<{ id: string; title: string; due_at: string | null }>(
      `SELECT id, title, due_at::text FROM app.learning_tasks WHERE id = $1`,
      [taskId],
    );
    return result.rows[0] ?? null;
  }

  async getTaskAnalytics(taskId: string) {
    const [learners, courses, progress, events] = await Promise.all([
      this.pool.query<TaskLearnerAnalyticsRow>(
        `SELECT a.user_id AS student_id, COALESCE(p.display_name, u.name) AS name,
                a.status, a.progress_percent::double precision, a.mastery_percent::double precision,
                a.effective_seconds::double precision, a.last_seen_at::text
           FROM app.task_assignments a
           JOIN public."user" u ON u.id = a.user_id
           LEFT JOIN app.user_profiles p ON p.user_id = a.user_id
          WHERE a.task_id = $1
          ORDER BY a.assigned_at`,
        [taskId],
      ),
      this.pool.query<TaskCourseAnalyticsRow>(
        `SELECT tc.course_id, tc.position, tc.is_required, c.title, c.content
           FROM app.task_courses tc
           JOIN app.courses c ON c.id = tc.course_id
          WHERE tc.task_id = $1
          ORDER BY tc.position`,
        [taskId],
      ),
      this.pool.query<TaskCourseProgressRow>(
        `SELECT task_id::text, course_id, user_id AS student_id, status,
                progress_percent::double precision, effective_seconds::double precision
           FROM app.task_course_progress
          WHERE task_id = $1`,
        [taskId],
      ),
      this.pool.query<TaskLearningEventRow>(
        `SELECT user_id AS student_id, event_type, scene_id, created_at::text
           FROM app.learning_events
          WHERE task_id = $1`,
        [taskId],
      ),
    ]);
    return { learners: learners.rows, courses: courses.rows, progress: progress.rows, events: events.rows };
  }

  async listBriefs(taskId: string) {
    const [summaries, suggestions] = await Promise.all([
      this.pool.query(
        `SELECT id, scope, user_id AS student_id, content, model, data_version, created_at::text
           FROM app.ai_learning_summaries
          WHERE task_id = $1
          ORDER BY created_at DESC`,
        [taskId],
      ),
      this.pool.query(
        `SELECT s.id, COALESCE(array_agg(t.user_id) FILTER (WHERE t.user_id IS NOT NULL), ARRAY[]::text[]) AS learner_ids,
                s.scene_ids, s.reason, s.evidence, s.status, s.created_task_id, s.created_at::text
           FROM app.ai_intervention_suggestions s
           LEFT JOIN app.ai_intervention_targets t ON t.suggestion_id = s.id
          WHERE s.task_id = $1
          GROUP BY s.id
          ORDER BY s.created_at DESC`,
        [taskId],
      ),
    ]);
    return { summaries: summaries.rows, suggestions: suggestions.rows };
  }

  async storeBrief(input: {
    taskId: string;
    summaries: Array<{ scope: 'class' | 'learner'; userId: string | null; content: unknown; model: string; promptVersion: string; dataVersion: string }>;
    suggestions: Array<{ learnerIds: string[]; sceneIds: string[]; reason: string; evidence: unknown }>;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const summaries = [];
      for (const summary of input.summaries) {
        const result = await client.query(
          `INSERT INTO app.ai_learning_summaries
             (task_id, scope, user_id, content, model, prompt_version, data_version)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
           RETURNING id, scope, user_id AS student_id, content, model, data_version, created_at::text`,
          [input.taskId, summary.scope, summary.userId, JSON.stringify(summary.content), summary.model, summary.promptVersion, summary.dataVersion],
        );
        summaries.push(result.rows[0]);
      }
      const suggestions = [];
      for (const suggestion of input.suggestions) {
        const created = await client.query(
          `INSERT INTO app.ai_intervention_suggestions (task_id, scene_ids, reason, evidence)
           VALUES ($1, $2::text[], $3, $4::jsonb)
           RETURNING id, scene_ids, reason, evidence, status, created_task_id, created_at::text`,
          [input.taskId, suggestion.sceneIds, suggestion.reason, JSON.stringify(suggestion.evidence)],
        );
        if (suggestion.learnerIds.length) {
          await client.query(
            `INSERT INTO app.ai_intervention_targets (suggestion_id, user_id)
             SELECT $1, unnest($2::text[])
             ON CONFLICT DO NOTHING`,
            [created.rows[0].id, suggestion.learnerIds],
          );
        }
        suggestions.push({ ...created.rows[0], learner_ids: suggestion.learnerIds });
      }
      await client.query('COMMIT');
      return { summaries, suggestions };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getSuggestion(taskId: string, suggestionId: string) {
    const result = await this.pool.query(
      `SELECT s.id, s.task_id, s.scene_ids, s.reason, s.status, s.created_task_id,
              COALESCE(array_agg(t.user_id) FILTER (WHERE t.user_id IS NOT NULL), ARRAY[]::text[]) AS learner_ids
         FROM app.ai_intervention_suggestions s
         LEFT JOIN app.ai_intervention_targets t ON t.suggestion_id = s.id
        WHERE s.id = $1 AND s.task_id = $2
        GROUP BY s.id`,
      [suggestionId, taskId],
    );
    return result.rows[0] ?? null;
  }

  async acceptSuggestion(suggestionId: string, createdTaskId: string) {
    const result = await this.pool.query(
      `UPDATE app.ai_intervention_suggestions
          SET status = 'accepted', created_task_id = $2, updated_at = now()
        WHERE id = $1 AND created_task_id IS NULL
        RETURNING id`,
      [suggestionId, createdTaskId],
    );
    return result.rowCount === 1;
  }
}
