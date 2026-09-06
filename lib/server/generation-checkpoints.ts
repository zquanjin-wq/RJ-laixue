import {
  ClassroomGenerationRepository,
  generationRequestHash,
  type GenerationLease,
} from './db/classroom-generation-repository';

export interface GenerationCheckpoints {
  run<T>(key: string, input: unknown, produce: () => Promise<T>): Promise<T>;
}

/** Only successfully persisted steps are reusable; interrupted external calls may repeat. */
export function createGenerationCheckpoints(
  repository: ClassroomGenerationRepository,
  lease: GenerationLease,
  configSnapshot: unknown,
): GenerationCheckpoints {
  return {
    async run<T>(key: string, input: unknown, produce: () => Promise<T>): Promise<T> {
      const fingerprint = generationRequestHash({ version: 1, configSnapshot, input });
      const saved = await repository.readStep<{ value: T }>(lease, key, fingerprint);
      if (saved !== null) return saved.value;
      const value = await produce();
      await repository.saveStep(lease, key, fingerprint, { value });
      // Use the same JSON semantics as a subsequent process reading the snapshot.
      return JSON.parse(JSON.stringify({ value })).value as T;
    },
  };
}
