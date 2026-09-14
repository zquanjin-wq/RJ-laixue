import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { getCurrentActor } from '@/lib/server/auth-context';
import {
  getAccountManagementAccess,
  listAccountAuditEvents,
  listManageableOrganizationUnits,
  listManagedPeople,
} from '@/lib/server/account-management';
import { AccountManagementClient } from './_components/account-management-client';

export const dynamic = 'force-dynamic';

export default async function AccountManagementPage() {
  const actor = await getCurrentActor();
  if (!actor) redirect('/login?next=/admin/accounts');
  const access = await getAccountManagementAccess(actor);
  if (!access) redirect(actor.role === 'teacher' ? '/courses' : '/student/courses');
  const [people, organizations, auditEvents] = await Promise.all([
    listManagedPeople(actor),
    listManageableOrganizationUnits(actor),
    access.kind === 'admin' ? listAccountAuditEvents() : Promise.resolve([]),
  ]);
  return (
    <main className="min-h-screen bg-muted/20 px-4 py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-1 text-sm font-medium text-primary">组织与账号</p>
            <h1 className="text-3xl font-semibold tracking-tight">成员账号</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {access.kind === 'admin'
                ? '管理全部成员、组织归属和教师账号管理权。'
                : '你只能管理已授权组织范围内的学员。'}
            </p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/courses">课程管理</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/admin/learning-tasks">学习任务</Link>
            </Button>
          </div>
        </header>
        <AccountManagementClient
          initialPeople={people}
          organizations={organizations}
          isAdmin={access.kind === 'admin'}
          auditEvents={auditEvents}
        />
      </div>
    </main>
  );
}
