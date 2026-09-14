import { redirect } from 'next/navigation';
import { getCurrentActor } from '@/lib/server/auth-context';
import { getAccountManagementAccess } from '@/lib/server/account-management';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login?next=/admin');
  if (await getAccountManagementAccess(actor)) redirect('/admin/accounts');
  if (actor.role === 'teacher') redirect('/courses');
  redirect('/student/courses');
}
