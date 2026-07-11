/**
 * POST /api/admin/students/create-account
 *
 * Admin-only. Provisions a Supabase Auth account for an existing
 * student row and binds students.user_id to the new auth user.
 *
 * Body:
 *   { student_id: string, email: string, display_name?: string, password?: string }
 *
 * Responses:
 *   200 { success, user_id, email, initial_password, bound_to_student }
 *   400 invalid JSON / missing fields / email already exists
 *   401 not signed in
 *   403 signed in but not admin
 *   404 student not found / already bound
 *   500 auth or DB error
 *
 * Flow:
 *   1. Confirm the caller is signed in (cookie session) and their profile is admin.
 *   2. Validate the student row exists and is not already bound.
 *   3. Use the service-role client to create the auth.users row with
 *      email_confirm=true so the learner can sign in immediately.
 *      The handle_new_user trigger will create the profile row.
 *   4. Bind students.user_id to the new user.
 */
import { NextResponse } from 'next/server';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';

interface CreateAccountBody {
  student_id?: unknown;
  email?: unknown;
  display_name?: unknown;
  password?: unknown;
}

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

function badRequest(message: string) {
  return NextResponse.json(
    { success: false, errorCode: 'INVALID_REQUEST', error: message },
    { status: 400 },
  );
}

export async function POST(request: Request) {
  // 1. Caller identity
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

  const { data: profile } = await serverSupabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile || profile.role !== 'admin') {
    return NextResponse.json(
      {
        success: false,
        errorCode: 'FORBIDDEN',
        error: '只有管理员可以创建学员账号。',
      },
      { status: 403 },
    );
  }

  // 2. Body
  let body: CreateAccountBody;
  try {
    body = (await request.json()) as CreateAccountBody;
  } catch {
    return badRequest('请求体不是合法 JSON。');
  }
  const studentId = typeof body.student_id === 'string' ? body.student_id.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const displayName =
    typeof body.display_name === 'string' && body.display_name.trim()
      ? body.display_name.trim()
      : email.split('@')[0] || '学员';
  const password =
    typeof body.password === 'string' && body.password.length >= 6
      ? body.password
      : generateInitialPassword();

  if (!studentId) return badRequest('缺少学员 ID。');
  if (!email || !email.includes('@')) return badRequest('邮箱格式不正确。');

  // 3. Service-role client
  const serviceSupabase = getServiceSupabase();

  // 3a. Validate student exists and is not bound
  const { data: student, error: lookupError } = await serviceSupabase
    .from('students')
    .select('id, name, user_id')
    .eq('id', studentId)
    .maybeSingle();
  if (lookupError) {
    return NextResponse.json(
      { success: false, errorCode: 'INTERNAL_ERROR', error: '查询学员失败，请重试。' },
      { status: 500 },
    );
  }
  if (!student) {
    return NextResponse.json(
      { success: false, errorCode: 'NOT_FOUND', error: '学员档案不存在。' },
      { status: 404 },
    );
  }
  if (student.user_id) {
    return NextResponse.json(
      {
        success: false,
        errorCode: 'ALREADY_BOUND',
        error: '该学员已经绑定到账号，请先解绑再创建。',
      },
      { status: 409 },
    );
  }

  // 3b. Create auth user
  const { data: created, error: createError } =
    await serviceSupabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    });

  if (createError || !created?.user) {
    const msg = createError?.message ?? '创建账号失败，请重试。';
    return NextResponse.json(
      {
        success: false,
        errorCode: 'AUTH_CREATE_FAILED',
        error: msg,
      },
      { status: 400 },
    );
  }

  const newUserId = created.user.id;

  // 3c. Bind student.user_id
  // The handle_new_user trigger should have fired and created a profiles row.
  // We don't wait for it explicitly; the students.user_id FK is to auth.users
  // which is already in place after admin.createUser returns.
  const { error: bindError } = await serviceSupabase
    .from('students')
    .update({ user_id: newUserId })
    .eq('id', studentId)
    .is('user_id', null);

  if (bindError) {
    return NextResponse.json(
      {
        success: false,
        errorCode: 'BIND_FAILED',
        error: '账号已创建，但绑定学员失败，请联系开发协助。',
        user_id: newUserId,
        email,
        initial_password: password,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    user_id: newUserId,
    student_id: studentId,
    email,
    initial_password: password,
    bound_to_student: true,
  });
}