/**
 * Compatibility marker for the retired Supabase learner APIs.
 *
 * Learner accounts now live in Better Auth's public."user" and
 * app.user_profiles tables. Course enrollment is managed through published
 * app.learning_tasks and app.task_assignments. This module deliberately has
 * no data-access code so no legacy Supabase path can be reintroduced.
 */
export const LEGACY_LEARNING_API_ERROR_CODE = 'LEGACY_LEARNING_API_DEPRECATED';

export const LEGACY_LEARNING_API_MESSAGE =
  '旧学员邀请码和单课程直连分配已停用；请由管理员创建学员账号并通过学习任务分配课程。';
