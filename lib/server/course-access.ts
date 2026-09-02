/**
 * lib/server/course-access.ts
 *
 * 课程可读授权的共享判定（单一事实来源）。消费方：
 *   - app/api/courses/[id]/route.ts 的 GET（2026-07-23 加固的原始实现）；
 *   - runtime API 中 stageId == courseId 的写入门禁（POST /api/runtime/v1/sessions，
 *     R1.1 补上——此前任何登录用户可在任意 courseId 下建运行时会话）。
 *
 * 判定规则与 courses GET 加固逐条一致：
 *   1. share 链接（opts.shareLink）：任何登录用户可读（RJ 内部链接分享策略）；
 *   2. admin：可读全部；
 *   3. teacher：可读自己创建的；created_by 为空的遗留数据放行；
 *   4. learner：必须有 course_assignments → students.user_id 指向自己；
 *   5. 其余：forbidden。
 */
import { getServiceSupabase } from '@/lib/supabase/server';
import { isGlobalCourseManager } from '@/lib/server/course-management-access';

export type CourseReadAccess = { ok: true } | { ok: false; reason: 'not_found' | 'forbidden' };

export async function checkCourseReadAccess(
  userId: string,
  courseId: string,
  opts: { shareLink?: boolean } = {},
): Promise<CourseReadAccess> {
  const serviceSupabase = getServiceSupabase();

  // 与 courses GET 相同：并行取调用者角色与课程 created_by（便宜）。
  const [{ data: profile }, { data: course }] = await Promise.all([
    serviceSupabase.from('profiles').select('role').eq('id', userId).maybeSingle(),
    serviceSupabase.from('courses').select('id, created_by').eq('id', courseId).maybeSingle(),
  ]);
  if (!course) return { ok: false, reason: 'not_found' };

  const role = (profile?.role ?? 'learner') as 'admin' | 'teacher' | 'learner';

  // share 链接只改变「读」授权；runtime 写入的是 learner 自己的分区
  // （learnerKey 强制 = auth.uid()），不泄漏任何他人数据。
  if (opts.shareLink) return { ok: true };

  if (course.created_by === userId) return { ok: true };

  if (role === 'admin' || role === 'teacher') {
    // Only the exceptional global course manager needs an email lookup.
    const { data: caller } = await serviceSupabase.auth.admin.getUserById(userId);
    if (isGlobalCourseManager(caller.user?.email)) return { ok: true };
  }
  if (role === 'admin') return { ok: false, reason: 'forbidden' };
  if (role === 'teacher') {
    if (!course.created_by) return { ok: true };
    return { ok: false, reason: 'forbidden' };
  }

  // learner：必须存在指向自己的 course_assignments 行
  const { data: assignment } = await serviceSupabase
    .from('course_assignments')
    .select('id, student_id, students!inner(user_id)')
    .eq('course_id', courseId)
    .eq('students.user_id', userId)
    .maybeSingle();
  if (assignment) return { ok: true };
  return { ok: false, reason: 'forbidden' };
}
