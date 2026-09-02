import { describe, expect, it } from 'vitest';
import { fingerprintSpeechVoice, speechVoiceMatches } from '@/lib/audio/voice-fingerprint';

const voice = { providerId: 'minimax-tts', voiceId: 'male-qingnian', modelId: 'speech-2.8-hd' };

describe('speech voice fingerprint', () => {
  it('matches only the same voice and normalized text', () => {
    const fingerprint = fingerprintSpeechVoice('你好，  同学', voice);
    expect(speechVoiceMatches(fingerprint, '你好， 同学', voice)).toBe(true);
    expect(speechVoiceMatches(fingerprint, '你好，同学！', voice)).toBe(false);
    expect(speechVoiceMatches(fingerprint, '你好， 同学', { ...voice, voiceId: 'female-yujie' })).toBe(false);
  });

  it('treats legacy unmarked audio as untrusted', () => {
    expect(speechVoiceMatches(undefined, '你好', voice)).toBe(false);
  });
});
