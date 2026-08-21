/**
 * GET /api/admin/students
 *
 * 返回可分配的学员列表（id, name, email），供教师和管理员选择学习对象。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { resolveActor } from '@/lib/server/learning-tasks/permissions';

export async function GET(request: NextRequest) {
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
    const searchParams = request.nextUrl.searchParams;
    const keyword = searchParams.get('q')?.trim() ?? '';
    const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
    const pageSize = Math.min(50, Math.max(10, Number(searchParams.get('pageSize') ?? '20') || 20));
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = svc
      .from('students')
      .select('id, name, email, disabled_at', { count: 'exact' })
      .order('name', { ascending: true })
      .range(from, to)
      .is('disabled_at', null);

    if (keyword) {
      query = query.or(`name.ilike.%${keyword}%,email.ilike.%${keyword}%`);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    return NextResponse.json({
      success: true,
      data: data ?? [],
      page,
      pageSize,
      total: count ?? 0,
    });
  } catch (error: unknown) {
    console.error('[admin/students] list failed:', error);
    return NextResponse.json(
      { success: false, error: '获取学员列表失败', errorCode: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
