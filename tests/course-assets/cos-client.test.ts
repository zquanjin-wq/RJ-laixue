import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadCourseBlob, uploadCourseMaterial, uploadPptxGenerationSource } from '@/lib/course-assets/client';

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
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
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
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/course-assets/confirm-upload',
      expect.objectContaining({ method: 'POST' }),
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
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const uploaded = await uploadCourseMaterial(
      'pending-123',
      new Blob(['document'], { type: 'application/pdf' }),
    );

    expect(uploaded).toEqual({ path: 'pending/user-1/material/file.pdf', size: 8 });
  });

  it('confirms a PPTX asset before registering it as a generation source', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: {
        assetId: '11111111-1111-4111-8111-111111111111', path: 'pending/user-1/material/source.pptx', uploadUrl: 'https://cos.example/upload', publicUrl: '/api/course-assets/object?key=source',
      } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sourceId: '22222222-2222-4222-8222-222222222222' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', { randomUUID: () => 'local-pending-id' });
    const source = await uploadPptxGenerationSource(new File(['pptx'], 'source.pptx', { type: 'application/octet-stream' }));
    expect(source).toEqual({ sourceId: '22222222-2222-4222-8222-222222222222', path: 'pending/user-1/material/source.pptx' });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/generation-sources/pptx', expect.objectContaining({ method: 'POST' }));
  });
});
