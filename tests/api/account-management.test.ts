import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  requireUser,
  createManagedLearner,
  generateInitialPassword,
  setManagedLearnerDisabled,
  updateManagedPerson,
  resetManagedPersonPassword,
} = vi.hoisted(() => ({
  requireUser: vi.fn(),
  createManagedLearner: vi.fn(),
  generateInitialPassword: vi.fn(),
  setManagedLearnerDisabled: vi.fn(),
  updateManagedPerson: vi.fn(),
  resetManagedPersonPassword: vi.fn(),
}));

vi.mock('@/lib/server/auth-context', () => ({ requireUser }));
vi.mock('@/lib/server/account-management', () => ({
  createManagedLearner,
  generateInitialPassword,
  setManagedLearnerDisabled,
  updateManagedPerson,
  resetManagedPersonPassword,
  listManagedPeople: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

describe('delegated account management API', () => {
  it('normalizes email and creates a learner in the selected organization', async () => {
    requireUser.mockResolvedValue({ userId: 'teacher-1', role: 'teacher' });
    generateInitialPassword.mockReturnValue('InitialPass1');
    createManagedLearner.mockResolvedValue({ id: 'learner-1' });
    const { POST } = await import('@/app/api/account-management/learners/route');
    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          displayName: '学员',
          email: 'LEARNER@EXAMPLE.COM',
          organizationUnitId: 'org-1',
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(createManagedLearner).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'teacher-1' }),
      {
        displayName: '学员',
        email: 'learner@example.com',
        organizationUnitId: 'org-1',
        password: 'InitialPass1',
      },
    );
  });

  it('passes learner enable and disable through the scoped service', async () => {
    requireUser.mockResolvedValue({ userId: 'teacher-1', role: 'teacher' });
    const { PATCH } = await import('@/app/api/account-management/learners/[userId]/route');
    const response = await PATCH(
      new Request('http://localhost', {
        method: 'PATCH',
        body: JSON.stringify({ disabled: true }),
      }),
      { params: Promise.resolve({ userId: 'learner-1' }) },
    );
    expect(response.status).toBe(200);
    expect(setManagedLearnerDisabled).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'teacher-1' }),
      'learner-1',
      true,
    );
  });

  it('does not expose whether an out-of-scope learner exists', async () => {
    requireUser.mockResolvedValue({ userId: 'teacher-1', role: 'teacher' });
    setManagedLearnerDisabled.mockRejectedValue(new Error('NotFound'));
    const { PATCH } = await import('@/app/api/account-management/learners/[userId]/route');
    const response = await PATCH(
      new Request('http://localhost', {
        method: 'PATCH',
        body: JSON.stringify({ disabled: true }),
      }),
      { params: Promise.resolve({ userId: 'outside' }) },
    );
    expect(response.status).toBe(404);
  });

  it('updates an account name, email and organization through the scoped service', async () => {
    requireUser.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
    const { PATCH } = await import('@/app/api/account-management/people/[userId]/route');
    const response = await PATCH(
      new Request('http://localhost', {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: '正确姓名',
          email: 'PERSON@EXAMPLE.COM',
          organizationUnitId: 'org-1',
        }),
      }),
      { params: Promise.resolve({ userId: 'person-1' }) },
    );
    expect(response.status).toBe(200);
    expect(updateManagedPerson).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      'person-1',
      { displayName: '正确姓名', email: 'person@example.com', organizationUnitId: 'org-1' },
    );
  });

  it('accepts an administrator supplied password with a minimum length', async () => {
    requireUser.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
    const { POST } = await import('@/app/api/account-management/people/[userId]/password/route');
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ password: 'NewPass2026!' }),
    });
    const response = await POST(request, { params: Promise.resolve({ userId: 'person-1' }) });
    expect(response.status).toBe(200);
    expect(resetManagedPersonPassword).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'admin-1' }),
      'person-1',
      'NewPass2026!',
      request.headers,
    );
  });
});
