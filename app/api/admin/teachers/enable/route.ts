/**
 * POST /api/admin/teachers/enable
 *
 * Admin-only. Clears profiles.disabled_at on a teacher account so
 * the teacher can sign in again.
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
      { success: false, errorCode: 'FORBIDDEN', error: '只有管理员可以启用老师。' },
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

  const { error: updateError } = await serviceSupabase
    .from('profiles')
    .update({ disabled_at: null })
    .eq('id', teacherId)
    .eq('role', 'teacher');
  if (updateError) {
    return NextResponse.json(
      { success: false, errorCode: 'DB_ERROR', error: updateError.message },
      { status: 500 },
    );
  }

  revalidatePath('/admin/teachers');
  return NextResponse.json({ success: true, teacher_id: teacherId });
}