import { redirect } from 'next/navigation';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { StudentCoursesView } from './student-courses-view';

type StudentRow = { id: string; name: string; disabled_at: string | null };

export const dynamic = 'force-dynamic';

export default async function StudentCoursesPage() {
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();
  if (!user) redirect('/login?next=/student/courses');

  const serviceSupabase = getServiceSupabase();
  const { data: callerProfile } = await serviceSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  if (callerProfile?.role === 'admin') redirect('/admin');

  const { data: student } = (await serviceSupabase
    .from('students')
    .select('id, name, disabled_at')
    .eq('user_id', user.id)
    .maybeSingle()) as { data: StudentRow | null };
  if (!student) return <main className="min-h-screen bg-background p-10">???????????????????</main>;
  if (student.disabled_at) return <main className="min-h-screen bg-background p-10">???????</main>;

  const { data: taskLearners } = await serviceSupabase
    .from('task_learners')
    .select('task_id')
    .eq('student_id', student.id);
  const taskIds = (taskLearners ?? []).map((item) => item.task_id);
  const { data: tasks } = taskIds.length
    ? await serviceSupabase
        .from('learning_tasks')
        .select('id, title, description, share_token, due_at, created_at')
        .in('id', taskIds)
        .eq('status', 'published')
        .order('created_at', { ascending: false })
    : { data: [] };

  return <StudentCoursesView studentName={student.name} tasks={tasks ?? []} />;
}
