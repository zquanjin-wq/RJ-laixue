import { NextResponse } from 'next/server';
import {
  LEGACY_LEARNING_API_ERROR_CODE,
  LEGACY_LEARNING_API_MESSAGE,
} from '@/lib/server/learning-mvp';

/**
 * The Supabase access-code binding flow was retired with the Better Auth
 * learner-account migration. Do not inspect or persist a submitted code here:
 * accepting it would recreate a second identity-binding path.
 */
export async function POST(_request: Request) {
  return NextResponse.json(
    {
      success: false,
      errorCode: LEGACY_LEARNING_API_ERROR_CODE,
      error: LEGACY_LEARNING_API_MESSAGE,
    },
    { status: 410 },
  );
}
