import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/server/auth-context';
import { getDatabasePool } from '@/lib/server/db/pool';
import { StudentCoursesView } from './student-courses-view';
export const dynamic='force-dynamic';
export default async function StudentCoursesPage(){const actor=await getCurrentActor();if(!actor)redirect('/login?next=/student/courses');if(actor.role!=='learner')redirect('/');const tasks=(await getDatabasePool().query<{id:string;title:string;description:string|null;share_token:string;due_at:string|null;created_at:string}>(`SELECT t.id::text,t.title,t.description,t.share_token,t.due_at::text,t.created_at::text FROM app.task_assignments a JOIN app.learning_tasks t ON t.id=a.task_id WHERE a.user_id=$1 AND t.status='published' ORDER BY t.created_at DESC`,[actor.userId])).rows;return <StudentCoursesView studentName={actor.name} tasks={tasks}/>;}
