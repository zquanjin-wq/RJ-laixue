/**
 * POST /api/admin/students/unbind
 *
 * Admin-only. Detaches the student row from its auth.users row:
 *   1. Sets students.user_id = NULL.
 *   2. Deletes the auth.users row (so the email can be reused for a
 *      different student later).
 *
 * Safety: refuses if the target auth.users row has role='admin',
 * so an admin can never accidentally unbind themselves.
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
      { success: false, errorCode: 'FORBIDDEN', error: '只有管理员可以解绑账号。' },
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
  if (!student || !student.user_id) {
    return NextResponse.json(
      { success: false, errorCode: 'NOT_FOUND', error: '该学员尚未绑定账号，无需解绑。' },
      { status: 404 },
    );
  }

  // Safety: refuse to unbind another admin.
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
        error: '不能解绑管理员账号。如需调整，请联系上级管理员。',
      },
      { status: 403 },
    );
  }

  // 1) Detach the student
  const { error: detachError } = await serviceSupabase
    .from('students')
    .update({ user_id: null })
    .eq('id', studentId);
  if (detachError) {
    return NextResponse.json(
      { success: false, errorCode: 'DB_ERROR', error: detachError.message },
      { status: 500 },
    );
  }

  // 2) Delete the auth user (best effort — log if it fails but
  // don't block the unbinding since the student row is already free)
  const { error: deleteError } =
    await serviceSupabase.auth.admin.deleteUser(student.user_id);
  if (deleteError) {
    return NextResponse.json({
      success: true,
      student_id: studentId,
      warning: `学员已解绑，但删除 auth 账号失败：${deleteError.message}`,
    });
  }

  return NextResponse.json({ success: true, student_id: studentId });
}