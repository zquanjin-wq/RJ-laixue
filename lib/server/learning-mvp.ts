import { supabase } from '@/lib/supabase/client';

export interface StudentInput {
  name: string;
  email?: string;
  employee_no?: string;
  note?: string;
}

export interface LearningEventInput {
  courseId: string;
  studentId?: string;
  eventType: 'open_course' | 'view_scene' | 'complete_course';
  sceneId?: string;
  sceneOrder?: number;
  metadata?: Record<string, unknown>;
}

export function getErrorMessage(error: unknown, fallback = '未知错误') {
  return error instanceof Error ? error.message : fallback;
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
  const { data, error } = await supabase
    .from('students')
    .select('id, name, access_code')
    .eq('access_code', accessCode)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Access code not found');

  const { data: assignment, error: assignError } = await supabase
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
  const { data, error } = await supabase
    .from('students')
    .select('id, name, access_code, email, employee_no, note, created_at, updated_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function createStudent(input: StudentInput) {
  const student = normalizeStudentInput(input);
  const { data, error } = await supabase
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
      const { data, error } = await supabase
        .from('students')
        .upsert(student, { onConflict: 'email' })
        .select('id, name, access_code, email, employee_no, note, created_at, updated_at')
        .single();
      if (error) throw error;
      results.push(data);
    } else if (student.employee_no) {
      const { data, error } = await supabase
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
  const { data, error } = await supabase
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
  const rows = [...new Set(studentIds)]
    .filter(Boolean)
    .map((studentId) => ({
      course_id: courseId,
      student_id: studentId,
    }));

  if (rows.length === 0) return [];

  const { data, error } = await supabase
    .from('course_assignments')
    .upsert(rows, {
      onConflict: 'course_id,student_id',
      ignoreDuplicates: true,
    })
    .select('id, course_id, student_id, status, assigned_at');
  if (error) throw error;
  return data ?? [];
}

export async function recordLearningEvent(input: LearningEventInput) {
  const { courseId, studentId, eventType, sceneId, sceneOrder, metadata } = input;

  let assignment:
    | {
        id: string;
        status: 'not_started' | 'in_progress' | 'completed';
      }
    | null = null;

  if (studentId) {
    const { data, error } = await supabase
      .from('course_assignments')
      .select('id, status')
      .eq('course_id', courseId)
      .eq('student_id', studentId)
      .maybeSingle();
    if (error) throw error;
    assignment = data;
  }

  const { error: eventError } = await supabase.from('course_progress_events').insert({
    course_id: courseId,
    student_id: studentId || null,
    assignment_id: assignment?.id ?? null,
    event_type: eventType,
    scene_id: sceneId || null,
    scene_order: typeof sceneOrder === 'number' ? sceneOrder : null,
    metadata: metadata ?? {},
  });
  if (eventError) throw eventError;

  if (assignment) {
    const now = new Date().toISOString();
    const patch =
      eventType === 'complete_course'
        ? {
            status: 'completed',
            completed_at: now,
            last_seen_at: now,
          }
        : assignment.status === 'not_started'
          ? {
              status: 'in_progress',
              started_at: now,
              last_seen_at: now,
            }
          : {
              last_seen_at: now,
            };

    const { error } = await supabase
      .from('course_assignments')
      .update(patch)
      .eq('id', assignment.id);
    if (error) throw error;
  }

  return { success: true };
}
