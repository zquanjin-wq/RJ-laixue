/**
 * POST /api/admin/teachers/reset-password
 *
 * Admin-only. Generates a new 12-char password for a teacher
 * (profiles.role='teacher') auth.users row and returns it once.
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
  const { data: callerProfile } = await serviceSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  if (!callerProfile || callerProfile.role !== 'admin') {
    return NextResponse.json(
      { success: false, errorCode: 'FORBIDDEN', error: '只有管理员可以重置老师密码。' },
      { status: 403 },
    );
  }

  let body: { teacher_id?: unknown };
  try {
    body = (await request.json()) as { teacher_id?: unknown };
  } catch {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: '请求体不是合法 JSON。' },
      { status: 400 },
    );
  }
  const teacherId = typeof body.teacher_id === 'string' ? body.teacher_id.trim() : '';
  if (!teacherId) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: '缺少老师 ID。' },
      { status: 400 },
    );
  }

  const { data: teacherProfile, error: lookupErr } = await serviceSupabase
    .from('profiles')
    .select('id, role')
    .eq('id', teacherId)
    .maybeSingle();
  if (lookupErr) {
    return NextResponse.json(
      { success: false, errorCode: 'DB_ERROR', error: lookupErr.message },
      { status: 500 },
    );
  }
  if (!teacherProfile || teacherProfile.role !== 'teacher') {
    return NextResponse.json(
      { success: false, errorCode: 'NOT_FOUND', error: '该 ID 不是老师账号。' },
      { status: 404 },
    );
  }

  const newPassword = generateInitialPassword();
  const { error: updateError } = await serviceSupabase.auth.admin.updateUserById(
    teacherId,
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
    teacher_id: teacherId,
    initial_password: newPassword,
  });
}