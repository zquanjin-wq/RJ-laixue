import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, getServerSupabase } from '@/lib/supabase/server';
// GET /api/courses/[id] — 获取单个课程完整数据
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const serviceSupabase = getServiceSupabase();
    const { data, error } = await serviceSupabase
      .from('courses')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !data) {
      return NextResponse.json(
        { success: false, error: '课程不存在' },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, data });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message },
      { status: 500 },
    );
  }
}
// DELETE /api/courses/[id] — 删除云端课程（仅 owner 可删）
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    // Identify the caller and check ownership before deleting.
    const serverSupabase = await getServerSupabase();
    const {
      data: { user },
    } = await serverSupabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { success: false, errorCode: 'UNAUTHENTICATED', error: '请先登录后再删除课程' },
        { status: 401 },
      );
    }

    const serviceSupabase = getServiceSupabase();

    // Verify the caller owns this course before deleting.
    const { data: row, error: lookupErr } = await serviceSupabase
      .from('courses')
      .select('created_by')
      .eq('id', id)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!row) {
      return NextResponse.json(
        { success: false, errorCode: 'NOT_FOUND', error: '课程不存在' },
        { status: 404 },
      );
    }
    if (row.created_by !== user.id) {
      return NextResponse.json(
        {
          success: false,
          errorCode: 'FORBIDDEN',
          error: '只有课程的创建者才能删除',
        },
        { status: 403 },
      );
    }

    const { error } = await serviceSupabase
      .from('courses')
      .delete()
      .eq('id', id)
      .eq('created_by', user.id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message },
      { status: 500 },
    );
  }
}
