/**
 * POST /api/admin/students/[id]/enable
 *
 * Admin-only. Re-enables a previously disabled student by clearing
 * students.disabled_at. The auth.users row is left alone (it never
 * got deleted by disable) so the learner can sign back in with the
 * same email and (typically) the same password — if the admin
 * already reset it during the disabled period, use the reset-password
 * flow to issue a new one.
 */
import { NextResponse } from 'next/server';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: studentId } = await params;

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
      { success: false, errorCode: 'FORBIDDEN', error: '只有管理员可以恢复学员。' },
      { status: 403 },
    );
  }

  if (!studentId) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: '缺少学员 ID。' },
      { status: 400 },
    );
  }

  const { error: updateError } = await serviceSupabase
    .from('students')
    .update({ disabled_at: null })
    .eq('id', studentId);
  if (updateError) {
    return NextResponse.json(
      { success: false, errorCode: 'DB_ERROR', error: updateError.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, student_id: studentId });
}