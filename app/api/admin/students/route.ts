/**
 * GET /api/admin/students
 *
 * 返回学员列表（id, name, email, disabled_at），供教师选择学习任务学员。
 * Admin 返回全部，teacher 返回未禁用的学员（管理员为任务分配用）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { resolveActor } from '@/lib/server/learning-tasks/permissions';

export async function GET(_request: NextRequest) {
  try {
    const serverSupabase = await getServerSupabase();
    const {
      data: { user },
    } = await serverSupabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { success: false, error: '未登录', errorCode: 'UNAUTHENTICATED' },
        { status: 401 },
      );
    }

    const actor = await resolveActor(user.id);
    if (actor.role === 'learner') {
      return NextResponse.json(
        { success: false, error: '无权查看学员列表', errorCode: 'FORBIDDEN' },
        { status: 403 },
      );
    }

    const svc = getServiceSupabase();
    let query = svc
      .from('students')
      .select('id, name, email, disabled_at')
      .order('created_at', { ascending: false });

    if (actor.role === 'teacher') {
      query = query.is('disabled_at', null);
    }

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ success: true, data: data ?? [] });
  } catch (error: unknown) {
    console.error('[admin/students] list failed:', error);
    return NextResponse.json(
      { success: false, error: '获取学员列表失败', errorCode: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
