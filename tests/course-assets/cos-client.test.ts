import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadCourseBlob, uploadCourseMaterial } from '@/lib/course-assets/client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('COS course asset client', () => {
  it('requests an upload address then sends the file directly to COS', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              path: 'courses/course-1/images/file.png',
              uploadUrl: 'https://cos.example/upload',
              publicUrl: '/api/course-assets/object?key=courses%2Fcourse-1%2Fimages%2Ffile.png',
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const assetUrl = await uploadCourseBlob(
      'course-1',
      'images',
      new Blob(['image'], { type: 'image/png' }),
    );

    expect(assetUrl).toContain('/api/course-assets/object');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/course-assets/sign-upload',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://cos.example/upload',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('keeps course material as an object key for the parser workflow', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              path: 'pending/user-1/material/file.pdf',
              uploadUrl: 'https://cos.example/upload',
              publicUrl: '/api/course-assets/object?key=pending',
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const uploaded = await uploadCourseMaterial(
      'pending-123',
      new Blob(['document'], { type: 'application/pdf' }),
    );

    expect(uploaded).toEqual({ path: 'pending/user-1/material/file.pdf', size: 8 });
  });
});
