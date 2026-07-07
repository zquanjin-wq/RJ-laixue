import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase/client';
// GET /api/courses — 列出云端课程
export async function GET() {
  try {
    const { data, error } = await supabase
      .from('courses')
      .select('id, title, topic, created_at, updated_at')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return NextResponse.json({ success: true, data });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message },
      { status: 500 },
    );
  }
}
// POST /api/courses — 保存课程到云端
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, title, topic, data } = body;
    if (!id) {
      return NextResponse.json(
        { success: false, error: '缺少课程 ID' },
        { status: 400 },
      );
    }
    const { error } = await supabase.from('courses').upsert(
      {
        id,
        title: title || '',
        topic: topic || '',
        data: data || {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message },
      { status: 500 },
    );
  }
}
