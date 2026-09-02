import { getServiceSupabase } from '@/lib/supabase/server';

// Use service_role so this server-side module can read AND write
// students / course_assignments / course_progress_events even
// after RLS is tightened (Wave 1 revoked anon writes). All callers
// are server-side API routes (app/api/learning/*, app/api/students/*,
// app/api/courses/[id]/assignments/*) so the service_role key never
// reaches the browser.
//
// We do NOT cache a module-level client so that tests can mock
// getServiceSupabase() before importing a route that uses this module.
function getSupabase() {
  return getServiceSupabase();
}

export interface StudentInput {
  name: string;
  email?: string;
  employee_no?: string;
  note?: string;
}

export type LearningEventType = 'open_course' | 'view_scene' | 'complete_course';

export interface LearningEventInput {
  courseId: string;
  eventType: LearningEventType;
  sceneId?: string;
  sceneOrder?: number;
  metadata?: Record<string, unknown>;
}

export interface VerifiedLearningContext {
  studentId: string;
  assignmentId: string;
}

export type LearningActorResolution =
  | { ok: true; actor: 'learner'; studentId: string; assignmentId: string }
  | { ok: true; actor: 'preview'; role: 'admin' | 'teacher' }
  | { ok: false; reason: 'not_bound' | 'disabled' | 'not_assigned' };

export function getErrorMessage(error: unknown, fallback = '未知错误') {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const source = error as {
      message?: unknown;
      details?: unknown;
      hint?: unknown;
      code?: unknown;
    };
    const parts = [source.message, source.details, source.hint, source.code]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .map((part) => part.trim());
    if (parts.length > 0) return parts.join(' | ');
  }
  return fallback;
}

function normalizeNullableText(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeStudentInput(input: StudentInput): StudentInput {
  const name = normalizeNullableText(input.name);
  if (!name) throw new Error('学生姓名不能为空');

  return {
    name,
    email: normalizeNullableText(input.email) ?? undefined,
    employee_no: normalizeNullableText(input.employee_no) ?? undefined,
    note: normalizeNullableText(input.note) ?? undefined,
  };
}

export async function verifyStudentAccess(courseId: string, accessCode: string) {
  const { data, error } = await getSupabase()
    .from('students')
    .select('id, name, access_code')
    .eq('access_code', accessCode)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Access code not found');

  const { data: assignment, error: assignError } = await getSupabase()
    .from('course_assignments')
    .select('id, status')
    .eq('course_id', courseId)
    .eq('student_id', data.id)
    .maybeSingle();
  if (assignError) throw assignError;
  if (!assignment) throw new Error('Student not assigned to this course');

  return { studentId: data.id, studentName: data.name };
}

export async function listStudents() {
  const { data, error } = await getSupabase()
    .from('students')
    .select('id, name, access_code, email, employee_no, note, created_at, updated_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function createStudent(input: StudentInput) {
  const student = normalizeStudentInput(input);
  const { data, error } = await getSupabase()
    .from('students')
    .insert(student)
    .select('id, name, access_code, email, employee_no, note, created_at, updated_at')
    .single();
  if (error) throw error;
  return data;
}

export async function importStudents(inputs: StudentInput[]) {
  const students = inputs.map(normalizeStudentInput);
  if (students.length === 0) return [];

  const results = [];
  for (const student of students) {
    if (student.email) {
      const { data, error } = await getSupabase()
        .from('students')
        .upsert(student, { onConflict: 'email' })
        .select('id, name, access_code, email, employee_no, note, created_at, updated_at')
        .single();
      if (error) throw error;
      results.push(data);
    } else if (student.employee_no) {
      const { data, error } = await getSupabase()
        .from('students')
        .upsert(student, { onConflict: 'employee_no' })
        .select('id, name, access_code, email, employee_no, note, created_at, updated_at')
        .single();
      if (error) throw error;
      results.push(data);
    } else {
      results.push(await createStudent(student));
    }
  }

  return results;
}

export async function listCourseAssignments(courseId: string) {
  const { data, error } = await getSupabase()
    .from('course_assignments')
    .select(
      [
        'id',
        'course_id',
        'student_id',
        'status',
        'assigned_at',
        'started_at',
        'completed_at',
        'last_seen_at',
        'students(id, name, email, employee_no)',
      ].join(', '),
    )
    .eq('course_id', courseId)
    .order('assigned_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function assignCourse(courseId: string, studentIds: string[]) {
  const rows = [...new Set(studentIds)].filter(Boolean).map((studentId) => ({
    course_id: courseId,
    student_id: studentId,
  }));

  if (rows.length === 0) return [];

  const { data, error } = await getSupabase()
    .from('course_assignments')
    .upsert(rows, {
      onConflict: 'course_id,student_id',
      ignoreDuplicates: true,
    })
    .select('id, course_id, student_id, status, assigned_at');
  if (error) throw error;
  return data ?? [];
}

export async function resolveLearningActor(
  userId: string,
  courseId: string,
): Promise<LearningActorResolution> {
  // 1. 从 authenticated user ID 查询 profiles.role
  const { data: profile, error: profileError } = await getSupabase()
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();
  if (profileError) throw profileError;

  // 2. admin/teacher 返回 preview，不查找或伪装 student
  const role = profile?.role;
  if (role === 'admin' || role === 'teacher') {
    return { ok: true, actor: 'preview', role };
  }

  // 3. learner（含 profile 缺失时的默认规则）通过 user_id 查询 student
  const { data: student, error: studentError } = await getSupabase()
    .from('students')
    .select('id, disabled_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (studentError) throw studentError;

  // 4. student 不存在
  if (!student) {
    return { ok: false, reason: 'not_bound' };
  }

  // 5. disabled_at 非空
  if (student.disabled_at != null) {
    return { ok: false, reason: 'disabled' };
  }

  // 6. 查询 (course_id, student_id) 的 course_assignments
  const { data: assignment, error: assignmentError } = await getSupabase()
    .from('course_assignments')
    .select('id, status')
    .eq('course_id', courseId)
    .eq('student_id', student.id)
    .maybeSingle();
  if (assignmentError) throw assignmentError;

  // 7. assignment 不存在
  if (!assignment) {
    return { ok: false, reason: 'not_assigned' };
  }

  // 8. 返回服务端解析出的 studentId + assignmentId
  return {
    ok: true,
    actor: 'learner',
    studentId: student.id,
    assignmentId: assignment.id,
  };
}

export async function recordLearningEvent(
  input: LearningEventInput,
  context: VerifiedLearningContext,
) {
  const { courseId, eventType, sceneId, sceneOrder, metadata } = input;
  const { studentId, assignmentId } = context;

  // 纵深防御：assignment 必须同时匹配 course + student + 给定 assignmentId
  const { data: assignment, error: assignmentError } = await getSupabase()
    .from('course_assignments')
    .select('id, status')
    .eq('id', assignmentId)
    .eq('course_id', courseId)
    .eq('student_id', studentId)
    .maybeSingle();
  if (assignmentError) throw assignmentError;

  // 不允许无 student/assignment 的正式学习事件落库
  if (!assignment) {
    throw new Error('Assignment verification failed');
  }

  const { error: eventError } = await getSupabase()
    .from('course_progress_events')
    .insert({
      course_id: courseId,
      student_id: studentId,
      assignment_id: assignmentId,
      event_type: eventType,
      scene_id: sceneId || null,
      scene_order: typeof sceneOrder === 'number' ? sceneOrder : null,
      metadata: metadata ?? {},
    });
  if (eventError) throw eventError;

  const now = new Date().toISOString();
  const patch =
    eventType === 'complete_course'
      ? {
          status: 'completed' as const,
          completed_at: now,
          last_seen_at: now,
        }
      : assignment.status === 'not_started'
        ? {
            status: 'in_progress' as const,
            started_at: now,
            last_seen_at: now,
          }
        : {
            last_seen_at: now,
          };

  // 更新 assignment 时使用已验证 assignmentId，并附加 student/course 条件作纵深防御
  const { error } = await getSupabase()
    .from('course_assignments')
    .update(patch)
    .eq('id', assignmentId)
    .eq('course_id', courseId)
    .eq('student_id', studentId);
  if (error) throw error;

  return { success: true };
}
