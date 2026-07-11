/**
 * POST /api/admin/students/delete
 *
 * Admin-only. Permanently removes a student row from public.students
 * and, if the student is currently bound to an auth.users row,
 * deletes that auth.users row as well. Use this when an admin no
 * longer wants the student on the platform at all.
 *
 * Body: { student_id: string }
 *
 * Safety: refuses (403) if the bound auth.users row has role='admin'
 * — admin accounts must not be removed through this path.
 */
import { NextResponse } from 'next/server';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';

export async function POST(request: Request) {
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { success: false, errorCode: 'UNAUTHENTICATED', error: '请先登录管理员账号。' },
      { status: 401 },
    );
  }
  const serviceSupabase = getServiceSupabase();
  const { data: profile } = await serviceSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile || profile.role !== 'admin') {
    return NextResponse.json(
      { success: false, errorCode: 'FORBIDDEN', error: '只有管理员可以删除学员档案。' },
      { status: 403 },
    );
  }

  let body: { student_id?: unknown };
  try {
    body = (await request.json()) as { student_id?: unknown };
  } catch {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: '请求体不是合法 JSON。' },
      { status: 400 },
    );
  }
  const studentId = typeof body.student_id === 'string' ? body.student_id.trim() : '';
  if (!studentId) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: '缺少学员 ID。' },
      { status: 400 },
    );
  }

  const { data: student } = await serviceSupabase
    .from('students')
    .select('id, user_id')
    .eq('id', studentId)
    .maybeSingle();
  if (!student) {
    return NextResponse.json(
      { success: false, errorCode: 'NOT_FOUND', error: '学员档案不存在。' },
      { status: 404 },
    );
  }

  // Safety: refuse to remove another admin (defensive — student
  // rows never carry an admin, but keep the check explicit).
  if (student.user_id) {
    const { data: targetProfile } = await serviceSupabase
      .from('profiles')
      .select('role')
      .eq('id', student.user_id)
      .maybeSingle();
    if (targetProfile?.role === 'admin') {
      return NextResponse.json(
        {
          success: false,
          errorCode: 'REFUSED',
          error: '不能删除管理员账号关联的学员档案。',
        },
        { status: 403 },
      );
    }
  }

  // 1) Delete the bound auth user first so the FK + cascade stay
  //    consistent. Best-effort: if this fails we still drop the
  //    student row so the admin's "remove from platform" intent is
  //    honored. Surface the auth-delete failure in a warning.
  let authWarning: string | undefined;
  if (student.user_id) {
    const { error: deleteUserError } = await serviceSupabase.auth.admin.deleteUser(
      student.user_id,
    );
    if (deleteUserError) {
      authWarning = `已删除学员档案，但清理 auth 账号失败：${deleteUserError.message}`;
    }
  }

  // 2) Drop the student row.
  const { error: deleteStudentError } = await serviceSupabase
    .from('students')
    .delete()
    .eq('id', studentId);
  if (deleteStudentError) {
    return NextResponse.json(
      { success: false, errorCode: 'DB_ERROR', error: deleteStudentError.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    student_id: studentId,
    ...(authWarning ? { warning: authWarning } : {}),
  });
}