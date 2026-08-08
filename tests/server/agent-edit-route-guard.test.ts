/**
 * /api/agent/edit 的 RJ api-guard 加固测试。
 *
 * 背景：上游此路由零鉴权（BYOK 模式，用户烧自己的 key）；RJ 服务端统一配
 * MiniMax，未鉴权调用会直接烧 RJ 配额。cherry-pick edit_elements（v0.3.1
 * #895/#927）后必须补齐 requireAuthOrTeacher + rateLimitByUser。
 *
 * 只测 guard 行为（拒绝路径 + 顺序），agent 管线本身由上游测试覆盖。
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const requireAuthMock = vi.hoisted(() => vi.fn());
const rateLimitMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/api-guard', () => ({
  requireAuthOrTeacher: requireAuthMock,
  rateLimitByUser: rateLimitMock,
}));

// 编辑器开关常开，只测 guard 行为（开关语义另由 feature-flags 测试覆盖）。
vi.mock('@/lib/config/feature-flags', () => ({
  isMaicEditorEnabled: () => true,
}));

function mockRequest(body: unknown) {
  const json = vi.fn().mockResolvedValue(body);
  return { req: { json } as never, json };
}

function authedTeacher() {
  requireAuthMock.mockResolvedValue({
    ok: true,
    user: { id: 'teacher-1', email: 't@example.com' },
    role: 'teacher',
  });
  rateLimitMock.mockReturnValue({ ok: true, remaining: 9 });
}

describe('/api/agent/edit api-guard', () => {
  beforeEach(() => {
    vi.resetModules();
    requireAuthMock.mockReset();
    rateLimitMock.mockReset();
  });

  test('未登录 → 直接返回 guard 的 401，且从不解析 body', async () => {
    const unauthorized = new Response('unauthenticated', { status: 401 });
    requireAuthMock.mockResolvedValue({ ok: false, response: unauthorized });

    const { POST } = await import('@/app/api/agent/edit/route');
    const { req, json } = mockRequest({ message: '把标题改成红色' });
    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(json).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
  });

  test('learner 角色 → 403（编辑是作者侧能力）', async () => {
    requireAuthMock.mockResolvedValue({
      ok: false,
      response: new Response('forbidden', { status: 403 }),
    });

    const { POST } = await import('@/app/api/agent/edit/route');
    const { req } = mockRequest({ message: '把标题改成红色' });
    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(requireAuthMock).toHaveBeenCalledWith(['teacher', 'admin']);
  });

  test('超限速 → 429，且不进入 agent 流程', async () => {
    authedTeacher();
    rateLimitMock.mockReturnValue({
      ok: false,
      response: new Response('too many', { status: 429 }),
    });

    const { POST } = await import('@/app/api/agent/edit/route');
    const { req, json } = mockRequest({ message: '把标题改成红色' });
    const res = await POST(req);

    expect(res.status).toBe(429);
    expect(json).not.toHaveBeenCalled();
    expect(rateLimitMock).toHaveBeenCalledWith('teacher-1', 'agent-edit', 10, 60_000);
  });

  test('guard 通过后才解析 body：空 message 返回 400', async () => {
    authedTeacher();

    const { POST } = await import('@/app/api/agent/edit/route');
    const { req, json } = mockRequest({ message: '   ' });
    const res = await POST(req);

    expect(json).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(400);
  });
});
