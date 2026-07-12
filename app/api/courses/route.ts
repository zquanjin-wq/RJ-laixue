import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase/server';


export const runtime = 'nodejs';
export const maxDuration = 300;

// GET /api/courses — 列出云端课程
export async function GET() {
  try {
    const serviceSupabase = getServiceSupabase();
    const { data, error } = await serviceSupabase
      .from('courses')
      .select('id, title, topic, created_at, updated_at')
      .order('updated_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ success: true, data });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e?.message || 'Failed to list courses' },
      { status: 500 },
    );
  }
}

// POST /api/courses — 保存课程到云端，不在保存时重新生成 TTS
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

    const courseData = data || {};
    const stage = courseData.stage;
    const outlines = Array.isArray(courseData.outlines) ? courseData.outlines : [];
    const scenes = Array.isArray(courseData.scenes) ? courseData.scenes : [];

    if (!stage) {
      return NextResponse.json(
        { success: false, error: '缺少课程 stage 数据' },
        { status: 400 },
      );
    }

    const payload = {
      stage,
      scenes,
      outlines,
      audioGeneration: {
        attempted: false,
        skipped: true,
        reason: 'save_only_no_tts_generation',
        updatedAt: new Date().toISOString(),
      },
    };

    const serviceSupabase = getServiceSupabase();
    const { error } = await serviceSupabase.from('courses').upsert(
      {
        id,
        title: title || stage?.name || '',
        topic: topic || '',
        data: payload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );

    if (error) throw error;

    return NextResponse.json({
      success: true,
      data: {
        id,
        audioGeneration: payload.audioGeneration,
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e?.message || 'Failed to save course' },
      { status: 500 },
    );
  }
}
