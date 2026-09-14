import { afterEach, describe, expect, it, vi } from 'vitest';

const { requireUser, createManagedLearner, generateInitialPassword, setManagedLearnerDisabled } =
  vi.hoisted(() => ({
    requireUser: vi.fn(),
    createManagedLearner: vi.fn(),
    generateInitialPassword: vi.fn(),
    setManagedLearnerDisabled: vi.fn(),
  }));

vi.mock('@/lib/server/auth-context', () => ({ requireUser }));
vi.mock('@/lib/server/account-management', () => ({
  createManagedLearner,
  generateInitialPassword,
  setManagedLearnerDisabled,
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
});
