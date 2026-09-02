/**
 * POST /api/admin/students/[id]/disable
 *
 * Admin-only. Soft-deletes a student by setting students.disabled_at
 * to now(). The row stays in place (so historical course_assignments
 * and course_progress_events remain queryable) but the learner can
 * no longer sign in to /student/courses — that page gates on
 * disabled_at IS NULL.
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
      { success: false, errorCode: 'FORBIDDEN', error: '只有管理员可以禁用学员。' },
      { status: 403 },
    );
  }

  if (!studentId) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: '缺少学员 ID。' },
      { status: 400 },
    );
  }

  const { data: existing } = await serviceSupabase
    .from('students')
    .select('id, disabled_at')
    .eq('id', studentId)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json(
      { success: false, errorCode: 'NOT_FOUND', error: '学员档案不存在。' },
      { status: 404 },
    );
  }
  if (existing.disabled_at) {
    return NextResponse.json(
      { success: true, student_id: studentId, already_disabled: true },
    );
  }

  const { error: updateError } = await serviceSupabase
    .from('students')
    .update({ disabled_at: new Date().toISOString() })
    .eq('id', studentId);
  if (updateError) {
    return NextResponse.json(
      { success: false, errorCode: 'DB_ERROR', error: updateError.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, student_id: studentId });
}