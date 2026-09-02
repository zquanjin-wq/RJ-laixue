import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  dbPut: vi.fn(),
  nanoid: vi.fn(),
}));

vi.mock('@/lib/utils/database', () => ({
  db: {
    imageFiles: {
      put: mocks.dbPut,
    },
  },
}));

vi.mock('nanoid', () => ({
  nanoid: mocks.nanoid,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { storeImagesFromUrls } = await import('@/lib/utils/image-storage');

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('storeImagesFromUrls — position alignment', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.dbPut.mockResolvedValue(undefined);
    mocks.nanoid.mockReturnValue('test-session');
    // Mock global fetch
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns dense array with exact same length as input (no undefined holes)', async () => {
    // All downloads succeed
    const images = [
      { id: 'img_1', url: 'https://cdn.example/img1.png', pageNumber: 1 },
      { id: 'img_2', url: 'https://cdn.example/img2.png', pageNumber: 2 },
      { id: 'img_3', url: 'https://cdn.example/img3.png', pageNumber: 3 },
    ];

    fetchSpy.mockImplementation(async () =>
      new Response(new Blob(['fake-png'], { type: 'image/png' }), { status: 200 }),
    );

    const result = await storeImagesFromUrls(images, 1); // sequential: test alignment not concurrency

    expect(result).toHaveLength(3);
    // Every position is a defined string (no undefined, no hole)
    for (let i = 0; i < 3; i++) {
      expect(result[i]).toBeDefined();
      expect(typeof result[i]).toBe('string');
      if (result[i]) {
        expect(result[i]).toContain(`img_${i + 1}`);
      }
    }
    // All 3 should have succeeded (non-empty)
    expect(result.filter(Boolean)).toHaveLength(3);
  });

  it('fills empty string (not undefined) for failed downloads — no hole in array', async () => {
    // img_2 fails to download
    const images = [
      { id: 'img_1', url: 'https://cdn.example/img1.png', pageNumber: 1 },
      { id: 'img_2', url: 'https://cdn.example/broken.png', pageNumber: 2 },
      { id: 'img_3', url: 'https://cdn.example/img3.png', pageNumber: 3 },
    ];

    let call = 0;
    fetchSpy.mockImplementation(() => {
      call++;
      if (call === 2) {
        // img_2 → HTTP 404
        return Promise.resolve(new Response(null, { status: 404, statusText: 'Not Found' }));
      }
      return Promise.resolve(
        new Response(new Blob(['fake-png'], { type: 'image/png' }), { status: 200 }),
      );
    });

    const result = await storeImagesFromUrls(images, 1); // sequential

    // Exact same length as input — no holes
    expect(result).toHaveLength(3);

    // Position 0: img_1 → success
    expect(typeof result[0]).toBe('string');
    expect(result[0]).toContain('session_test-session_img_1');

    // Position 1: img_2 → FAILED → empty string, NOT undefined
    expect(result[1]).toBe('');

    // Position 2: img_3 → success (NOT shifted to position 1!)
    expect(typeof result[2]).toBe('string');
    expect(result[2]).toContain('session_test-session_img_3');
    expect(result[2]).not.toBe('');
  });

  it('handles network error (fetch throws) with empty string, not hole', async () => {
    const images = [
      { id: 'img_1', url: 'https://cdn.example/img1.png', pageNumber: 1 },
    ];

    fetchSpy.mockRejectedValue(new Error('Network error'));

    const result = await storeImagesFromUrls(images);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe('');
  });

  it('concurrent pool: all 6 workers produce correct positions', async () => {
    // 20 images → 6 concurrent workers → verify no overlap or misalignment
    const images = Array.from({ length: 20 }, (_, i) => ({
      id: `img_${i + 1}`,
      url: `https://cdn.example/img${i + 1}.png`,
      pageNumber: Math.ceil((i + 1) / 3),
    }));

    const receivedIds: string[] = [];
    fetchSpy.mockImplementation((url: string) => {
      const id = url.split('/').pop()?.split('.')[0] ?? '';
      receivedIds.push(id);
      return Promise.resolve(
        new Response(new Blob(['fake-png'], { type: 'image/png' }), { status: 200 }),
      );
    });

    const result = await storeImagesFromUrls(images, 6);

    // All 20 images were fetched
    expect(receivedIds.length).toBe(20);

    // Result has exactly 20 entries, all non-empty strings
    expect(result).toHaveLength(20);
    result.forEach((v) => {
      expect(typeof v).toBe('string');
      expect(v).toBeTruthy();
    });

    // Each storageId contains the correct img id
    for (let i = 0; i < 20; i++) {
      expect(result[i]).toContain(`img_${i + 1}`);
    }
  });
});
