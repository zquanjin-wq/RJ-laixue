import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { checkTaskManagePermission } from '@/lib/server/learning-tasks/permissions';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; suggestionId: string }> },
) {
  const { id: taskId, suggestionId } = await params;
  const server = await getServerSupabase();
  const {
    data: { user },
  } = await server.auth.getUser();
  if (!user)
    return NextResponse.json(
      { success: false, error: '请先登录', errorCode: 'UNAUTHENTICATED' },
      { status: 401 },
    );
  const permission = await checkTaskManagePermission(user.id, taskId);
  if (!permission.ok)
    return NextResponse.json(
      { success: false, error: '无权管理此任务', errorCode: 'FORBIDDEN' },
      { status: 403 },
    );
  try {
    const svc = getServiceSupabase();
    const { data: suggestion, error: suggestionError } = await svc
      .from('ai_intervention_suggestions')
      .select('id, task_id, learner_ids, scene_ids, reason, status, created_task_id')
      .eq('id', suggestionId)
      .eq('task_id', taskId)
      .maybeSingle();
    if (suggestionError) throw suggestionError;
    if (!suggestion)
      return NextResponse.json(
        { success: false, error: '建议不存在', errorCode: 'SUGGESTION_NOT_FOUND' },
        { status: 404 },
      );
    if (suggestion.created_task_id)
      return NextResponse.json({
        success: true,
        data: { taskId: suggestion.created_task_id, reused: true },
      });
    const { data: sourceTask, error: taskError } = await svc
      .from('learning_tasks')
      .select('course_id, title')
      .eq('id', taskId)
      .maybeSingle();
    if (taskError) throw taskError;
    if (!sourceTask)
      return NextResponse.json(
        { success: false, error: '任务不存在', errorCode: 'TASK_NOT_FOUND' },
        { status: 404 },
      );
    const title = `补学：${sourceTask.title}`;
    const { data: result, error: createError } = await svc.rpc('create_task_with_learners', {
      p_course_id: sourceTask.course_id,
      p_title: title,
      p_description: suggestion.reason,
      p_created_by: user.id,
      p_task_type: 'remedial',
      p_source_task_id: taskId,
      p_learner_ids: suggestion.learner_ids,
    });
    if (createError) throw createError;
    const createdTaskId = (result as { task_id?: string })?.task_id;
    if (!createdTaskId) throw new Error('补学任务创建失败');
    const { error: updateError } = await svc
      .from('ai_intervention_suggestions')
      .update({ status: 'accepted', created_task_id: createdTaskId })
      .eq('id', suggestionId);
    if (updateError) throw updateError;
    return NextResponse.json(
      { success: true, data: { taskId: createdTaskId, status: 'draft' } },
      { status: 201 },
    );
  } catch (error) {
    console.error('[ai-suggestion] accept failed:', error);
    return NextResponse.json(
      { success: false, error: '创建补学草稿失败', errorCode: 'CREATE_REMEDIAL_FAILED' },
      { status: 500 },
    );
  }
}
