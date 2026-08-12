/**
 * GET /api/classroom/snapshot?taskId=...
 *
 * 任务快照适配层：返回学习任务的不可变课程快照。
 * 必须登录；服务端解析身份，不接受客户端 studentId。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';
import { loadTaskSnapshot } from '@/lib/server/learning-tasks/snapshot-loader';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const taskId = request.nextUrl.searchParams.get('taskId');
  if (!taskId) {
    return NextResponse.json(
      { success: false, error: '缺少 taskId', errorCode: 'MISSING_TASK_ID' },
      { status: 400 },
    );
  }

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

  const result = await loadTaskSnapshot(user.id, taskId);

  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.error, errorCode: result.errorCode },
      { status: result.status },
    );
  }

  return NextResponse.json(
    { success: true, data: result.data, actor: result.actor },
    {
      headers: {
        'Cache-Control': 'private, no-store',
      },
    },
  );
}
