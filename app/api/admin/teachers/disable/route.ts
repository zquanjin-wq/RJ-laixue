/**
 * POST /api/admin/teachers/disable
 *
 * Admin-only. Sets profiles.disabled_at on a teacher account so the
 * teacher can no longer sign in. The auth.users row stays; can be
 * re-enabled by /api/admin/teachers/enable.
 */
import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
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
  const { data: callerProfile } = await serviceSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  if (!callerProfile || callerProfile.role !== 'admin') {
    return NextResponse.json(
      { success: false, errorCode: 'FORBIDDEN', error: '只有管理员可以禁用老师。' },
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
    .select('id, role, disabled_at')
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
  if (teacherProfile.disabled_at) {
    return NextResponse.json({
      success: true,
      teacher_id: teacherId,
      already_disabled: true,
    });
  }

  const { error: updateError } = await serviceSupabase
    .from('profiles')
    .update({ disabled_at: new Date().toISOString() })
    .eq('id', teacherId);
  if (updateError) {
    return NextResponse.json(
      { success: false, errorCode: 'DB_ERROR', error: updateError.message },
      { status: 500 },
    );
  }

  revalidatePath('/admin/teachers');
  return NextResponse.json({ success: true, teacher_id: teacherId });
}