'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type {
  AccountAuditEvent,
  ManagedPerson,
  OrganizationUnit,
} from '@/lib/server/account-management';

type Props = {
  initialPeople: ManagedPerson[];
  organizations: OrganizationUnit[];
  isAdmin: boolean;
  auditEvents: AccountAuditEvent[];
};

const ROLE_LABEL = { admin: '管理员', teacher: '教师', learner: '学员' } as const;
const AUDIT_LABEL: Record<string, string> = {
  'learner.created': '创建学员',
  'learner.disabled': '停用学员',
  'learner.enabled': '启用学员',
  'learner.password_reset': '重置学员密码',
  'organization.created': '创建组织',
  'organization.renamed': '重命名组织',
  'organization.disabled': '停用组织',
  'organization.enabled': '启用组织',
  'person.organization_changed': '调整成员组织',
  'grant.enabled': '授予账号管理权',
  'grant.revoked': '撤销账号管理权',
};
const AUDIT_DATE_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function AccountManagementClient({
  initialPeople,
  organizations,
  isAdmin,
  auditEvents,
}: Props) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('all');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [password, setPassword] = useState<{ email: string; value: string } | null>(null);
  const [learner, setLearner] = useState({
    displayName: '',
    email: '',
    organizationUnitId: organizations[0]?.id ?? '',
  });
  const [organization, setOrganization] = useState({ name: '', parentId: '' });
  const [editingOrganization, setEditingOrganization] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const people = useMemo(
    () =>
      initialPeople.filter((person) => {
        const matchesQuery =
          !query ||
          `${person.displayName} ${person.email}`.toLowerCase().includes(query.toLowerCase());
        return matchesQuery && (role === 'all' || person.role === role);
      }),
    [initialPeople, query, role],
  );

  async function request(path: string, options: RequestInit) {
    const response = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...options.headers },
    });
    const data = (await response.json()) as Record<string, any>;
    if (!response.ok) throw new Error(String(data.error || '操作失败。'));
    return data;
  }

  async function createLearner(event: React.FormEvent) {
    event.preventDefault();
    setBusy('create-learner');
    setMessage('');
    try {
      const data = await request('/api/account-management/learners', {
        method: 'POST',
        body: JSON.stringify(learner),
      });
      setPassword({ email: data.email, value: data.initialPassword });
      setLearner({ displayName: '', email: '', organizationUnitId: learner.organizationUnitId });
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建失败。');
    } finally {
      setBusy('');
    }
  }

  async function createOrganization(event: React.FormEvent) {
    event.preventDefault();
    setBusy('create-org');
    setMessage('');
    try {
      await request('/api/admin/organizations', {
        method: 'POST',
        body: JSON.stringify(organization),
      });
      setOrganization({ name: '', parentId: '' });
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建失败。');
    } finally {
      setBusy('');
    }
  }

  async function setPersonOrganization(userId: string, organizationUnitId: string) {
    setBusy(`org-${userId}`);
    setMessage('');
    try {
      await request(`/api/admin/people/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ organizationUnitId }),
      });
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '更新失败。');
    } finally {
      setBusy('');
    }
  }

  async function updateOrganization(id: string, input: { name?: string; disabled?: boolean }) {
    setBusy(`organization-${id}`);
    setMessage('');
    try {
      await request(`/api/admin/organizations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      });
      setEditingOrganization(null);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '更新组织失败。');
    } finally {
      setBusy('');
    }
  }

  async function toggleGrant(person: ManagedPerson) {
    const organizationUnitId = person.grantOrganizationUnitId || person.organizationUnitId || '';
    setBusy(`grant-${person.userId}`);
    setMessage('');
    try {
      await request('/api/admin/account-grants', {
        method: 'POST',
        body: JSON.stringify({
          userId: person.userId,
          organizationUnitId,
          includeDescendants: true,
          enabled: !person.canManageAccounts,
        }),
      });
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '授权失败。');
    } finally {
      setBusy('');
    }
  }

  async function toggleLearner(person: ManagedPerson) {
    setBusy(`status-${person.userId}`);
    setMessage('');
    try {
      await request(`/api/account-management/learners/${person.userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ disabled: !person.banned }),
      });
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '更新失败。');
    } finally {
      setBusy('');
    }
  }

  async function resetPassword(person: ManagedPerson) {
    setBusy(`password-${person.userId}`);
    setMessage('');
    try {
      const data = await request(`/api/account-management/learners/${person.userId}/password`, {
        method: 'POST',
      });
      setPassword({ email: person.email, value: data.initialPassword });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '重置失败。');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>创建学员</CardTitle>
            <CardDescription>学员首次登录后必须修改初始密码。</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-3" onSubmit={createLearner}>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="learner-name">姓名</Label>
                  <Input
                    id="learner-name"
                    value={learner.displayName}
                    onChange={(e) => setLearner({ ...learner, displayName: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="learner-email">邮箱</Label>
                  <Input
                    id="learner-email"
                    type="email"
                    value={learner.email}
                    onChange={(e) => setLearner({ ...learner, email: e.target.value })}
                    required
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="learner-org">所属组织</Label>
                <select
                  id="learner-org"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={learner.organizationUnitId}
                  onChange={(e) => setLearner({ ...learner, organizationUnitId: e.target.value })}
                  required
                >
                  <option value="">请选择</option>
                  {organizations
                    .filter((o) => !o.disabled)
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                </select>
              </div>
              <Button disabled={busy === 'create-learner' || !organizations.length}>
                {busy === 'create-learner' ? '创建中…' : '创建学员账号'}
              </Button>
            </form>
          </CardContent>
        </Card>
        {isAdmin && (
          <Card>
            <CardHeader>
              <CardTitle>新建组织</CardTitle>
              <CardDescription>建立可用于成员归属和授权的组织节点。</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-3" onSubmit={createOrganization}>
                <div>
                  <Label htmlFor="org-name">组织名称</Label>
                  <Input
                    id="org-name"
                    value={organization.name}
                    onChange={(e) => setOrganization({ ...organization, name: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="parent-org">上级组织</Label>
                  <select
                    id="parent-org"
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={organization.parentId}
                    onChange={(e) => setOrganization({ ...organization, parentId: e.target.value })}
                  >
                    <option value="">无（顶级组织）</option>
                    {organizations.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Button disabled={busy === 'create-org'}>
                  {busy === 'create-org' ? '创建中…' : '新建组织'}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
      {isAdmin && organizations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>组织架构</CardTitle>
            <CardDescription>停用前需先移出成员，并处理所有启用中的下级组织。</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y rounded-lg border">
              {organizations.map((unit) => {
                const parent = organizations.find((candidate) => candidate.id === unit.parentId);
                const editing = editingOrganization?.id === unit.id;
                return (
                  <div
                    key={unit.id}
                    className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 flex-1">
                      {editing ? (
                        <Input
                          value={editingOrganization.name}
                          onChange={(event) =>
                            setEditingOrganization({ id: unit.id, name: event.target.value })
                          }
                        />
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{unit.name}</span>
                          {unit.disabled && <Badge variant="secondary">已停用</Badge>}
                        </div>
                      )}
                      <p className="mt-1 text-xs text-muted-foreground">
                        上级：{parent?.name || '顶级组织'}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {editing ? (
                        <>
                          <Button
                            size="sm"
                            disabled={
                              busy === `organization-${unit.id}` || !editingOrganization.name.trim()
                            }
                            onClick={() =>
                              updateOrganization(unit.id, { name: editingOrganization.name.trim() })
                            }
                          >
                            保存
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingOrganization(null)}
                          >
                            取消
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditingOrganization({ id: unit.id, name: unit.name })}
                          >
                            重命名
                          </Button>
                          <Button
                            size="sm"
                            variant={unit.disabled ? 'default' : 'ghost'}
                            disabled={busy === `organization-${unit.id}`}
                            onClick={() =>
                              updateOrganization(unit.id, { disabled: !unit.disabled })
                            }
                          >
                            {unit.disabled ? '启用' : '停用'}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
      {password && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
          <p className="font-medium">初始密码只显示这一次</p>
          <p className="mt-1 text-sm">
            {password.email}：
            <span className="select-all font-mono font-semibold">{password.value}</span>
          </p>
          <Button className="mt-3" size="sm" onClick={() => setPassword(null)}>
            我已记录
          </Button>
        </div>
      )}
      {message && (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{message}</p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>成员账号</CardTitle>
          <CardDescription>{initialPeople.length} 个可管理账号</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              placeholder="搜索姓名或邮箱"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              <option value="all">全部角色</option>
              {isAdmin && <option value="admin">管理员</option>}
              {isAdmin && <option value="teacher">教师</option>}
              <option value="learner">学员</option>
            </select>
          </div>
          <div className="divide-y rounded-lg border">
            {people.length ? (
              people.map((person) => (
                <div
                  key={person.userId}
                  className="grid gap-3 p-4 lg:grid-cols-[1fr_180px_auto] lg:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{person.displayName}</span>
                      <Badge variant="outline">{ROLE_LABEL[person.role]}</Badge>
                      <Badge variant={person.banned ? 'destructive' : 'default'}>
                        {person.banned ? '已停用' : '已启用'}
                      </Badge>
                      {person.canManageAccounts && <Badge>账号管理员</Badge>}
                    </div>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      {person.email} · {person.organizationName || '未分配组织'}
                      {person.mustChangePassword ? ' · 待首次改密' : ''}
                    </p>
                  </div>
                  {isAdmin ? (
                    <select
                      aria-label={`设置 ${person.displayName} 的组织`}
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                      value={person.organizationUnitId || ''}
                      disabled={busy === `org-${person.userId}`}
                      onChange={(e) => setPersonOrganization(person.userId, e.target.value)}
                    >
                      <option value="">未分配组织</option>
                      {organizations.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-sm text-muted-foreground">{person.organizationName}</span>
                  )}
                  <div className="flex flex-wrap justify-start gap-2 lg:justify-end">
                    {person.role === 'learner' && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === `password-${person.userId}`}
                          onClick={() => resetPassword(person)}
                        >
                          重置密码
                        </Button>
                        <Button
                          variant={person.banned ? 'default' : 'ghost'}
                          size="sm"
                          disabled={busy === `status-${person.userId}`}
                          onClick={() => toggleLearner(person)}
                        >
                          {person.banned ? '启用' : '停用'}
                        </Button>
                      </>
                    )}
                    {isAdmin && person.role === 'teacher' && (
                      <Button
                        variant={person.canManageAccounts ? 'destructive' : 'outline'}
                        size="sm"
                        disabled={
                          busy === `grant-${person.userId}` ||
                          (!person.canManageAccounts && !person.organizationUnitId)
                        }
                        title={
                          !person.organizationUnitId && !person.canManageAccounts
                            ? '请先给教师分配组织'
                            : undefined
                        }
                        onClick={() => toggleGrant(person)}
                      >
                        {person.canManageAccounts ? '撤销账号管理权' : '授予账号管理权'}
                      </Button>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <p className="p-8 text-center text-sm text-muted-foreground">没有符合条件的账号。</p>
            )}
          </div>
        </CardContent>
      </Card>
      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>最近操作</CardTitle>
            <CardDescription>最近 {auditEvents.length} 条组织与账号变更记录。</CardDescription>
          </CardHeader>
          <CardContent>
            {auditEvents.length ? (
              <div className="divide-y rounded-lg border">
                {auditEvents.map((event) => (
                  <div
                    key={event.id}
                    className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                  >
                    <p>
                      <span className="font-medium">{event.actorName}</span>
                      <span className="text-muted-foreground">
                        {' '}
                        {AUDIT_LABEL[event.action] || event.action}
                      </span>
                      {event.targetName && <span> · {event.targetName}</span>}
                      {event.organizationName && (
                        <span className="text-muted-foreground"> · {event.organizationName}</span>
                      )}
                    </p>
                    <time className="text-xs text-muted-foreground">
                      {AUDIT_DATE_FORMAT.format(new Date(event.createdAt))}
                    </time>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">暂无操作记录。</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
