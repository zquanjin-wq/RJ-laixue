import { NextRequest, NextResponse } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { resolveModel } from '@/lib/server/resolve-model';
import { resolveActor } from '@/lib/server/learning-tasks/permissions';
import { isGlobalCourseManager } from '@/lib/server/course-management-access';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';

type CourseReport = {
  course?: { title?: unknown };
  overview?: {
    taskCount?: unknown;
    learnerCount?: unknown;
    completedCount?: unknown;
    completionRate?: unknown;
    effectiveSeconds?: unknown;
  };
  tasks?: unknown;
  chapters?: unknown;
};

type RequestBody = {
  question?: unknown;
  report?: CourseReport;
  modelString?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  providerType?: unknown;
  thinkingConfig?: unknown;
};

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: courseId } = await params;
  const server = await getServerSupabase();
  const {
    data: { user },
  } = await server.auth.getUser();
  if (!user)
    return NextResponse.json(
      { success: false, error: '请先登录', errorCode: 'UNAUTHENTICATED' },
      { status: 401 },
    );

  const actor = await resolveActor(user.id);
  if (actor.role === 'learner')
    return NextResponse.json(
      { success: false, error: '无权查看课程数据', errorCode: 'FORBIDDEN' },
      { status: 403 },
    );

  let body: RequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: '请求格式错误', errorCode: 'INVALID_BODY' },
      { status: 400 },
    );
  }
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question)
    return NextResponse.json(
      { success: false, error: '请输入问题', errorCode: 'QUESTION_REQUIRED' },
      { status: 400 },
    );
  if (!body.report || typeof body.report !== 'object')
    return NextResponse.json(
      { success: false, error: '课程统计尚未加载完成', errorCode: 'REPORT_REQUIRED' },
      { status: 400 },
    );

  try {
    const svc = getServiceSupabase();
    const { data: course, error: courseError } = await svc
      .from('courses')
      .select('id, title, created_by')
      .eq('id', courseId)
      .maybeSingle();
    if (courseError) throw courseError;
    if (!course)
      return NextResponse.json(
        { success: false, error: '课程不存在', errorCode: 'COURSE_NOT_FOUND' },
        { status: 404 },
      );
    if (!isGlobalCourseManager(user.email) && course.created_by !== user.id)
      return NextResponse.json(
        { success: false, error: '无权查看此课程数据', errorCode: 'FORBIDDEN' },
        { status: 403 },
      );

    const { model, thinkingConfig } = await resolveModel({
      stage: 'teaching-data-chat',
      modelString: typeof body.modelString === 'string' ? body.modelString : undefined,
      apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
      providerType: typeof body.providerType === 'string' ? body.providerType : undefined,
      thinkingConfig:
        typeof body.thinkingConfig === 'object' ? (body.thinkingConfig as never) : undefined,
    });
    const result = await callLLM(
      {
        model,
        system:
          '你是课程学习效果分析助手。只解释提供的课程统计；没有数据就明确说“暂无数据”。不要虚构学员成绩、课程内容或学习原因。回答简洁，先给结论，再给1到3条基于数据的教学建议。不要创建、发布或修改任务。',
        prompt: `问题：${question}\n\n课程：${course.title || '未命名课程'}\n当前课程学习统计：${JSON.stringify(body.report)}`,
      },
      'course-data-chat',
      undefined,
      thinkingConfig,
    );
    return NextResponse.json(
      { success: true, data: { answer: result.text } },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    console.error('[course-insight] failed:', error);
    return NextResponse.json(
      { success: false, error: 'AI 课程解读暂时不可用，请稍后重试', errorCode: 'AI_QUERY_FAILED' },
      { status: 500 },
    );
  }
}
