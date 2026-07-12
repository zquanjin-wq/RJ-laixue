import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase/server';
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
// DELETE /api/courses/[id] — 删除云端课程
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const serviceSupabase = getServiceSupabase();
    const { error } = await serviceSupabase
      .from('courses')
      .delete()
      .eq('id', id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message },
      { status: 500 },
    );
  }
}
