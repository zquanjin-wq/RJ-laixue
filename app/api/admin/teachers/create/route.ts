/**
 * POST /api/admin/teachers/create
 *
 * Admin-only. Creates a "teacher" account: a Supabase Auth user who
 * can sign in, edit courses on /, and view the admin hub at
 * /admin (auth-gate allows admin + teacher). Teachers do NOT get
 * a public.students row — they are creators, not learners.
 *
 * Body: { name: string, email: string }
 * 200:  { success: true, user_id, email, initial_password }
 * 400:  validation errors
 * 401:  unauthenticated
 * 403:  not admin
 * 409:  email already taken
 * 500:  auth/db error
 */
import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';

const PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function generateInitialPassword(length = 12): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += PASSWORD_ALPHABET.charAt(
      Math.floor(Math.random() * PASSWORD_ALPHABET.length),
    );
  }
  return out;
}

export async function POST(request: Request) {
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { success: false, errorCode: 'UNAUTHENTICATED', error: '请先登录管理员账号。' },
      { status: 401 },
    );
  }
  const serviceSupabase = getServiceSupabase();
  const { data: profile } = await serviceSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile || profile.role !== 'admin') {
    return NextResponse.json(
      { success: false, errorCode: 'FORBIDDEN', error: '只有管理员可以创建老师账号。' },
      { status: 403 },
    );
  }

  let body: { name?: unknown; email?: unknown };
  try {
    body = (await request.json()) as { name?: unknown; email?: unknown };
  } catch {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: '请求体不是合法 JSON。' },
      { status: 400 },
    );
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!name) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: '请填写老师姓名。' },
      { status: 400 },
    );
  }
  if (!email || !email.includes('@') || email.length < 3) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: '邮箱格式不正确。' },
      { status: 400 },
    );
  }

  // Reject if email already exists in auth.users.
  const { data: existingUsers, error: listErr } =
    await serviceSupabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (listErr) {
    return NextResponse.json(
      { success: false, errorCode: 'AUTH_LIST_FAILED', error: listErr.message },
      { status: 500 },
    );
  }
  if (existingUsers?.users?.some((u) => u.email?.toLowerCase() === email)) {
    return NextResponse.json(
      {
        success: false,
        errorCode: 'EMAIL_TAKEN',
        error: `该邮箱已被占用：${email}`,
      },
      { status: 409 },
    );
  }

  const initialPassword = generateInitialPassword();

  const { data: created, error: createError } =
    await serviceSupabase.auth.admin.createUser({
      email,
      password: initialPassword,
      email_confirm: true,
      user_metadata: { display_name: name },
    });
  if (createError || !created?.user) {
    return NextResponse.json(
      {
        success: false,
        errorCode: 'AUTH_CREATE_FAILED',
        error: createError?.message ?? '创建账号失败，请重试。',
      },
      { status: 400 },
    );
  }
  const newUserId = created.user.id;

  // Override the role assigned by the handle_new_user trigger so the
  // new user is a teacher, not a learner. The trigger runs first
  // (inserts a learner row) and we update it immediately after.
  const { error: roleUpdateError } = await serviceSupabase
    .from('profiles')
    .update({ role: 'teacher' })
    .eq('id', newUserId);
  if (roleUpdateError) {
    // Roll back the auth user — we'd rather have nothing than a
    // half-provisioned teacher.
    await serviceSupabase.auth.admin.deleteUser(newUserId);
    return NextResponse.json(
      {
        success: false,
        errorCode: 'DB_ERROR',
        error: `创建账号成功但设置 teacher 角色失败：${roleUpdateError.message}`,
      },
      { status: 500 },
    );
  }

  revalidatePath('/admin/teachers');

  return NextResponse.json({
    success: true,
    user_id: newUserId,
    email,
    initial_password: initialPassword,
  });
}