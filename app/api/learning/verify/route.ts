import { NextResponse } from 'next/server';
import {
  LEGACY_LEARNING_API_ERROR_CODE,
  LEGACY_LEARNING_API_MESSAGE,
} from '@/lib/server/learning-mvp';

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      errorCode: LEGACY_LEARNING_API_ERROR_CODE,
      error: LEGACY_LEARNING_API_MESSAGE,
    },
    { status: 410 },
  );
}
