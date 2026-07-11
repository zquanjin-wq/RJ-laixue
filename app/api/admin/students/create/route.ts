/**
 * POST /api/admin/students/create
 *
 * Admin-only. One-shot provisioning: takes a learner name and email,
 * returns the new student's initial password once for the admin to
 * read back. Creates:
 *
 *   1. auth.users row (with email_confirm=true so the learner can
 *      sign in immediately, plus a fresh random password).
 *   2. public.students row bound to that auth.users via user_id.
 *      Note: the students.access_code column still exists in the
 *      schema (preserved for legacy data + the column's DEFAULT
 *      keeps generating a random code) but it is no longer part of
 *      the account-creation flow — sharing is by direct email +
 *      password handoff.
 *   3. public.profiles row via the handle_new_user DB trigger
 *      (role='learner').
 *
 * Validation:
 *   - email must look like an email and not already be taken in
 *     auth.users or public.students.
 *   - name is required.
 *
 * Body: { name: string, email: string }
 * 200:  { success: true, student_id, email, initial_password }
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
const ACCESS_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateInitialPassword(length = 12): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += PASSWORD_ALPHABET.charAt(
      Math.floor(Math.random() * PASSWORD_ALPHABET.length),
    );
  }
  return out;
}

function generateAccessCode(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ACCESS_CODE_ALPHABET.charAt(
      Math.floor(Math.random() * ACCESS_CODE_ALPHABET.length),
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
      { success: false, errorCode: 'FORBIDDEN', error: '只有管理员可以创建学员账号。' },
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
      { success: false, errorCode: 'INVALID_REQUEST', error: '请填写学员姓名。' },
      { status: 400 },
    );
  }
  if (!email || !email.includes('@') || email.length < 3) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: '邮箱格式不正确。' },
      { status: 400 },
    );
  }

  // 1) Reject if email already exists in either auth.users or students.
  //    auth.listUsers is paginated, but for an admin-only MVP this
  //    filter scan is fine and avoids extra admin APIs.
  const { data: existingStudent } = await serviceSupabase
    .from('students')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  if (existingStudent) {
    return NextResponse.json(
      {
        success: false,
        errorCode: 'EMAIL_TAKEN',
        error: `该邮箱已被学员档案使用：${email}`,
      },
      { status: 409 },
    );
  }
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

  // 2) Create the auth user. handle_new_user trigger creates profile.
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

  // 3) Insert the students row. The access_code column still exists
  //    in the schema but is no longer part of the account-creation
  //    contract — the column DEFAULT generates a random 6-char code
  //    automatically, which keeps the NOT NULL + UNIQUE constraints
  //    happy without us having to think about it.
  const { data: inserted, error: insertError } = await serviceSupabase
    .from('students')
    .insert({
      name,
      email,
      user_id: newUserId,
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    // Roll back the auth user so we don't leave an orphan auth row.
    await serviceSupabase.auth.admin.deleteUser(newUserId);
    return NextResponse.json(
      {
        success: false,
        errorCode: 'DB_ERROR',
        error: insertError?.message ?? '插入学员档案失败',
      },
      { status: 500 },
    );
  }

  // Force the /admin/students RSC to re-render so the admin sees the
  // new row without having to hard-refresh. Without this the page
  // sometimes shows a stale roster after a router.refresh() cycle.
  revalidatePath('/admin/students');

  return NextResponse.json({
    success: true,
    student_id: inserted.id,
    email,
    initial_password: initialPassword,
  });
}