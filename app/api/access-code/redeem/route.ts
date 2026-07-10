/**
 * POST /api/access-code/redeem
 *
 * Binds the currently signed-in Supabase Auth user to a student row
 * identified by its 6-character access_code. After binding, subsequent
 * logins resolve the user's assignments through students.user_id instead
 * of requiring the access_code again.
 *
 * Body: { code: "ABC123" }
 *
 * Responses:
 *   200 { success: true, studentId, studentName, alreadyBound }
 *   400 invalid JSON / missing code
 *   401 not signed in
 *   404 access_code not found
 *   409 access_code already bound to a different auth.users.id
 *   500 db error
 *
 * Service-role is used for the read + update because learning tables
 * still ship with anon-key RLS — using the cookie-bound client here
 * would expose this write to anyone with the access_code. This route
 * is the trusted redemption surface until stage-two policies tighten
 * RLS to authenticated-only.
 */
import { NextResponse } from 'next/server';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';

interface RedeemResponse {
  success: true;
  studentId: string;
  studentName: string;
  alreadyBound: boolean;
}

interface RedeemError {
  success: false;
  errorCode:
    | 'INVALID_REQUEST'
    | 'UNAUTHENTICATED'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'INTERNAL_ERROR';
  error: string;
}

export async function POST(request: Request) {
  let body: { code?: unknown };
  try {
    body = (await request.json()) as { code?: unknown };
  } catch {
    return NextResponse.json(
      {
        success: false,
        errorCode: 'INVALID_REQUEST',
        error: '请求体不是合法 JSON。',
      } satisfies RedeemError,
      { status: 400 },
    );
  }

  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!code) {
    return NextResponse.json(
      {
        success: false,
        errorCode: 'INVALID_REQUEST',
        error: '请输入有效的访问码。',
      } satisfies RedeemError,
      { status: 400 },
    );
  }

  // 1. Confirm the caller is signed in (cookie session from getServerSupabase).
  const serverSupabase = await getServerSupabase();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      {
        success: false,
        errorCode: 'UNAUTHENTICATED',
        error: '请先登录账号再绑定访问码。',
      } satisfies RedeemError,
      { status: 401 },
    );
  }

  // 2. Look up the student by access_code using the service-role client.
  //    Supabase Auth is loaded here so the caller identity is trustworthy,
  //    and the redemption write is centralised before stage-two RLS
  //    hardening moves this responsibility into Postgres functions.
  const serviceSupabase = getServiceSupabase();

  const { data: student, error: lookupError } = await serviceSupabase
    .from('students')
    .select('id, name, access_code, user_id')
    .eq('access_code', code)
    .maybeSingle();

  if (lookupError) {
    return NextResponse.json(
      {
        success: false,
        errorCode: 'INTERNAL_ERROR',
        error: '查询访问码失败，请重试。',
      } satisfies RedeemError,
      { status: 500 },
    );
  }

  if (!student) {
    return NextResponse.json(
      {
        success: false,
        errorCode: 'NOT_FOUND',
        error: '访问码不存在，请检查后重试。',
      } satisfies RedeemError,
      { status: 404 },
    );
  }

  if (student.user_id && student.user_id !== user.id) {
    return NextResponse.json(
      {
        success: false,
        errorCode: 'CONFLICT',
        error: '此访问码已经绑定到其他账号。',
      } satisfies RedeemError,
      { status: 409 },
    );
  }

  if (student.user_id !== user.id) {
    const { error: updateError } = await serviceSupabase
      .from('students')
      .update({ user_id: user.id })
      .eq('id', student.id)
      .eq('user_id', null); // belt-and-suspenders to avoid racing on re-bound
    if (updateError) {
      return NextResponse.json(
        {
          success: false,
          errorCode: 'INTERNAL_ERROR',
          error: '绑定访问码失败，请重试。',
        } satisfies RedeemError,
        { status: 500 },
      );
    }
  }

  return NextResponse.json({
    success: true,
    studentId: student.id,
    studentName: student.name,
    alreadyBound: student.user_id === user.id,
  } satisfies RedeemResponse);
}
