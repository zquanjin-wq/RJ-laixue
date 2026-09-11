import { describe, expect, it } from 'vitest';
import { describeGenerationFailure } from '@/lib/server/durable-classroom-worker';

describe('durable classroom failure diagnostics', () => {
  it('reports a retryable narration failure without exposing provider details', () => {
    expect(describeGenerationFailure(new Error('TTS request to provider timed out'))).toEqual({
      code: 'TTS_GENERATION_FAILED',
      message: '课程讲解已生成，但配音未完成。请检查音色服务后重试该课程生成任务。',
    });
  });

  it('classifies source and configuration failures separately', () => {
    expect(describeGenerationFailure(new Error('PPTX source is unavailable'))).toMatchObject({
      code: 'PPTX_SOURCE_UNAVAILABLE',
    });
    expect(describeGenerationFailure(new Error('Generation configuration version is unavailable'))).toMatchObject({
      code: 'GENERATION_CONFIGURATION_UNAVAILABLE',
    });
  });

  it('does not misreport PPTX quality failures as missing source files', () => {
    expect(
      describeGenerationFailure(
        new Error('PPTX AI classroom quality validation failed: missing_element'),
      ),
    ).toEqual({
      code: 'GENERATION_QUALITY_FAILED',
      message: '课程内容校验未通过，未保存不完整结果。请重试该课程生成任务。',
    });
  });

  it('keeps unknown internal failures generic', () => {
    expect(describeGenerationFailure(new Error('internal endpoint https://secret.example/token'))).toEqual({
      code: 'GENERATION_FAILED',
      message: '课程生成未完成。可以重试任务，课程内容不会被不完整结果覆盖。',
    });
  });
});
