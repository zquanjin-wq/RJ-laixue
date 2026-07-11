/**
 * POST /api/admin/students/reset-password
 *
 * Admin-only. Generates a new random password for the auth.users
 * row bound to the given student and returns it once for the admin
 * to read back. The student can sign in immediately with the new
 * password (email_confirm stays true; Confirm Email is off).
 */
import { NextResponse } from 'next/server';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';

const PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function generateInitialPassword(length = 12): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += PASSWORD_ALPHABET.charAt(
      Math.floor(Math.random() * PASSWORD_ALPHABET.length),
    );
  }
  return out;
}

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
      { success: false, errorCode: 'FORBIDDEN', error: '只有管理员可以重置密码。' },
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
      { success: false, errorCode: 'NOT_FOUND', error: '该学员尚未绑定账号。' },
      { status: 404 },
    );
  }

  const newPassword = generateInitialPassword();
  const { error: updateError } = await serviceSupabase.auth.admin.updateUserById(
    student.user_id,
    { password: newPassword },
  );
  if (updateError) {
    return NextResponse.json(
      { success: false, errorCode: 'AUTH_UPDATE_FAILED', error: updateError.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    student_id: studentId,
    initial_password: newPassword,
  });
}