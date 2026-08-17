import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase, getServerSupabase } from '@/lib/supabase/server';
import { isGlobalCourseManager } from '@/lib/server/course-management-access';

export const runtime = 'nodejs';
export const maxDuration = 300;

// GET /api/courses — 列出云端课程
// ?scope=all (default) returns every course (used for "发现" browse)
// ?scope=mine returns only courses created by the signed-in user
//   (used for "我的课程" — owner-only edit/delete visibility)
export async function GET(request: NextRequest) {
  try {
    const serviceSupabase = getServiceSupabase();
    const scope = request.nextUrl.searchParams.get('scope') ?? 'mine';
    const selectFields = 'id, title, topic, created_by, created_at, updated_at';
    const serverSupabase = await getServerSupabase();
    const {
      data: { user },
    } = await serverSupabase.auth.getUser();
    if (!user)
      return NextResponse.json({ success: false, errorCode: 'UNAUTHENTICATED' }, { status: 401 });
    let query = serviceSupabase.from('courses').select(selectFields);
    if (scope === 'all' && !isGlobalCourseManager(user.email))
      return NextResponse.json({ success: false, errorCode: 'FORBIDDEN' }, { status: 403 });
    if (scope !== 'all') query = query.eq('created_by', user.id);

    const { data, error } = await query.order('updated_at', { ascending: false });

    if (error) throw error;

    const creatorIds = [
      ...new Set((data ?? []).map((course) => course.created_by).filter(Boolean)),
    ];
    const { data: creators } = creatorIds.length
      ? await serviceSupabase.from('students').select('user_id, name').in('user_id', creatorIds)
      : { data: [] };
    const creatorNameById = new Map(
      (creators ?? []).map((creator) => [creator.user_id, creator.name]),
    );
    const courses = (data ?? []).map((course) => ({
      ...course,
      author_name: course.created_by ? (creatorNameById.get(course.created_by) ?? null) : null,
    }));

    return NextResponse.json({ success: true, data: courses });
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
    const { id, title, topic, data, saveState = 'ready' } = body;

    if (!id) {
      return NextResponse.json({ success: false, error: '缺少课程 ID' }, { status: 400 });
    }

    const courseData = data || {};
    const stage = courseData.stage;
    const outlines = Array.isArray(courseData.outlines) ? courseData.outlines : [];
    const scenes = Array.isArray(courseData.scenes) ? courseData.scenes : [];

    if (!stage) {
      return NextResponse.json({ success: false, error: '缺少课程 stage 数据' }, { status: 400 });
    }

    const payload = {
      stage,
      scenes,
      outlines,
      saveState: saveState === 'draft' ? 'draft' : 'ready',
      audioGeneration: {
        attempted: false,
        skipped: true,
        reason: 'save_only_no_tts_generation',
        updatedAt: new Date().toISOString(),
      },
    };

    const serviceSupabase = getServiceSupabase();

    // ── Authorization gate ──────────────────────────────────────────
    // The upsert below uses the service_role client, which bypasses RLS
    // entirely. Without an explicit ownership check, any signed-in user
    // could POST a course id they don't own and overwrite its data
    // (and previously also hijack the created_by field). Gate on:
    //   - Course doesn't exist yet → caller becomes creator (new row INSERT)
    //   - Course exists and caller is the creator → UPDATE allowed
    //   - Course exists and caller is admin → UPDATE allowed
    //   - Course exists and caller is anyone else → 403
    //
    // We split the write into INSERT (caller as owner) vs UPDATE
    // (preserve original created_by) so a benign save never overwrites
    // the original owner — fixing the silent ownership-hijack bug too.
    const { data: existing } = await serviceSupabase
      .from('courses')
      .select('created_by')
      .eq('id', id)
      .maybeSingle();

    if (existing) {
      let callerIsAdmin = false;
      const { data: profile } = await serviceSupabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle();
      callerIsAdmin = profile?.role === 'admin';

      if (existing.created_by !== user.id && !callerIsAdmin) {
        return NextResponse.json(
          {
            success: false,
            errorCode: 'FORBIDDEN',
            error: '您没有权限保存此课程。',
          },
          { status: 403 },
        );
      }
    }

    const { error } = await serviceSupabase.from('courses').upsert(
      {
        id,
        title: title || stage?.name || '',
        topic: topic || '',
        data: payload,
        // Only set created_by on INSERT (when no existing row). On UPDATE
        // omit it so a teacher saving their own course cannot accidentally
        // clear the field, and a hostile save cannot transfer ownership.
        ...(existing ? {} : { created_by: user.id }),
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
