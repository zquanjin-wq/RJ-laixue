import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  requireStudentAdmin,
  listLearners,
  createLearner,
  setLearnerDisabled,
  generateStudentPassword,
  requireTeacherAdmin,
  createTeacher,
  setTeacherDisabled,
  generateTeacherPassword,
} = vi.hoisted(() => ({
  requireStudentAdmin: vi.fn(),
  listLearners: vi.fn(),
  createLearner: vi.fn(),
  setLearnerDisabled: vi.fn(),
  generateStudentPassword: vi.fn(),
  requireTeacherAdmin: vi.fn(),
  createTeacher: vi.fn(),
  setTeacherDisabled: vi.fn(),
  generateTeacherPassword: vi.fn(),
}));

vi.mock('@/lib/server/admin-students', () => ({
  requireAdmin: requireStudentAdmin,
  listLearners,
  createLearner,
  setLearnerDisabled,
  generateInitialPassword: generateStudentPassword,
}));
vi.mock('@/lib/server/admin-teachers', () => ({
  requireAdmin: requireTeacherAdmin,
  createTeacher,
  setTeacherDisabled,
  generateInitialPassword: generateTeacherPassword,
}));

afterEach(() => vi.resetAllMocks());

describe('admin student management API', () => {
  it('denies unauthenticated learner listing', async () => {
    requireStudentAdmin.mockRejectedValue(new Error('Unauthenticated'));
    const { GET } = await import('@/app/api/admin/students/route');

    expect((await GET()).status).toBe(401);
  });

  it('creates a learner only for an administrator', async () => {
    requireStudentAdmin.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
    generateStudentPassword.mockReturnValue('InitialPass1');
    createLearner.mockResolvedValue({ id: 'learner-1' });
    const { POST } = await import('@/app/api/admin/students/create/route');

    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ name: '学员', email: 'LEARNER@example.com' }),
    }));

    expect(response.status).toBe(200);
    expect(createLearner).toHaveBeenCalledWith({ name: '学员', email: 'learner@example.com', password: 'InitialPass1' });
  });

  it('does not disable an unknown learner', async () => {
    requireStudentAdmin.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
    setLearnerDisabled.mockResolvedValue(false);
    const { POST } = await import('@/app/api/admin/students/[id]/disable/route');

    const response = await POST(new Request('http://localhost', { method: 'POST' }), { params: Promise.resolve({ id: 'missing' }) });

    expect(response.status).toBe(404);
  });
});

describe('admin teacher management API', () => {
  it('denies non-administrators', async () => {
    requireTeacherAdmin.mockRejectedValue(new Error('Forbidden'));
    const { POST } = await import('@/app/api/admin/teachers/create/route');

    expect((await POST(new Request('http://localhost', { method: 'POST', body: '{}' }))).status).toBe(403);
  });

  it('creates and disables teachers through Better Auth backed helpers', async () => {
    requireTeacherAdmin.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
    generateTeacherPassword.mockReturnValue('InitialPass2');
    createTeacher.mockResolvedValue({ id: 'teacher-1' });
    setTeacherDisabled.mockResolvedValue(true);
    const { POST: create } = await import('@/app/api/admin/teachers/create/route');
    const { POST: disable } = await import('@/app/api/admin/teachers/disable/route');

    const created = await create(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ name: '教师', email: 'TEACHER@example.com' }),
    }));
    const disabled = await disable(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ teacher_id: 'teacher-1' }),
    }));

    expect(created.status).toBe(200);
    expect(createTeacher).toHaveBeenCalledWith({ name: '教师', email: 'teacher@example.com', password: 'InitialPass2' });
    expect(disabled.status).toBe(200);
    expect(setTeacherDisabled).toHaveBeenCalledWith('teacher-1', true);
  });
});
