import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, getServerSupabase } from '@/lib/supabase/server';


export const runtime = 'nodejs';
export const maxDuration = 300;

// GET /api/courses — 列出云端课程
// ?scope=all (default) returns every course (used for "发现" browse)
// ?scope=mine returns only courses created by the signed-in user
//   (used for "我的课程" — owner-only edit/delete visibility)
export async function GET(request: NextRequest) {
  try {
    const serviceSupabase = getServiceSupabase();
    const scope = request.nextUrl.searchParams.get('scope') ?? 'all';
    const selectFields = 'id, title, topic, created_by, created_at, updated_at';

    let query = serviceSupabase.from('courses').select(selectFields);

    if (scope === 'mine') {
      // Identify the caller via their cookie session. If unauthenticated,
      // return an empty array rather than leaking everyone's courses.
      const serverSupabase = await getServerSupabase();
      const {
        data: { user },
      } = await serverSupabase.auth.getUser();
      if (!user) {
        return NextResponse.json({ success: true, data: [] });
      }
      query = query.eq('created_by', user.id);
    }

    const { data, error } = await query.order('updated_at', { ascending: false });

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
    // Identify the caller for ownership attribution. The signed-in user
    // becomes the course creator (created_by). This is what the
    // 'mine' scope GET filter checks later.
    const serverSupabase = await getServerSupabase();
    const {
      data: { user },
    } = await serverSupabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { success: false, errorCode: 'UNAUTHENTICATED', error: '请先登录后再保存课程' },
        { status: 401 },
      );
    }

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
        created_by: user.id,
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
