import { randomUUID } from 'node:crypto';
import { CosStorage } from '@/lib/server/cos-storage';
import { CourseVideoExportRepository, type CourseVideoExport } from '@/lib/server/db/course-video-export-repository';
import { getDatabasePool } from '@/lib/server/db/pool';
import type { VideoExportCapability, VideoExportRecord, VideoExportRequestInput } from './video-export-contract';

const unavailableCapability: VideoExportCapability = {
  available: false,
  code: 'VIDEO_RENDERER_NOT_CONFIGURED',
  message: '课程视频渲染服务暂不可用。',
};

export interface VideoExportService {
  getCapability(): Promise<VideoExportCapability>;
  listForCourse(courseId: string): Promise<VideoExportRecord[]>;
  request(input: VideoExportRequestInput): Promise<VideoExportRecord & { inputUploadUrl: string }>;
  confirmInputUpload(id: string): Promise<VideoExportRecord | null>;
  getById(id: string): Promise<VideoExportRecord | null>;
}

export class VideoRendererNotConfiguredError extends Error {
  readonly code = 'VIDEO_RENDERER_NOT_CONFIGURED';
  constructor() { super(unavailableCapability.message); this.name = 'VideoRendererNotConfiguredError'; }
}

function rendererUrl() { return process.env.RENDER_SERVICE_URL?.trim().replace(/\/$/, ''); }

async function capability(): Promise<VideoExportCapability> {
  const url = rendererUrl();
  if (!url) return unavailableCapability;
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500), cache: 'no-store' });
    if (response.ok) return { available: true, code: 'VIDEO_RENDERER_NOT_CONFIGURED', message: '视频渲染服务可用。' };
  } catch { /* The API must degrade to 503 when the isolated service is unavailable. */ }
  return unavailableCapability;
}

function present(row: CourseVideoExport, downloadUrl: string | null = null): VideoExportRecord {
  return {
    id: row.id, courseId: row.courseId, requestedBy: row.requestedBy, format: 'mp4',
    status: row.status === 'running' ? 'rendering' : row.status === 'succeeded' ? 'completed' : row.status,
    sourceRevision: null, downloadUrl, failureReason: row.error,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

class PostgresVideoExportService implements VideoExportService {
  private readonly repository = new CourseVideoExportRepository(getDatabasePool());

  getCapability() { return capability(); }

  async listForCourse(courseId: string) {
    const storage = new CosStorage();
    return Promise.all((await this.repository.listForCourse(courseId)).map(async (row) =>
      present(row, row.output ? await storage.getDownloadUrl(row.output.objectKey) : null),
    ));
  }

  async request(input: VideoExportRequestInput) {
    if (!(await this.getCapability()).available) throw new VideoRendererNotConfiguredError();
    const row = await this.repository.create({ courseId: input.courseId, requestedBy: input.requestedBy });
    const inputObjectKey = `courses/${input.courseId}/video-exports/${row.id}/source-${randomUUID()}.zip`;
    await getDatabasePool().query(
      `UPDATE app.course_video_exports SET request = $2::jsonb, updated_at = now() WHERE id = $1`,
      [row.id, JSON.stringify({ uploadObjectKey: inputObjectKey, sourceRevision: input.sourceRevision ?? null })],
    );
    return { ...present({ ...row, request: { uploadObjectKey: inputObjectKey } }), inputUploadUrl: await new CosStorage().getUploadUrl(inputObjectKey) };
  }

  async confirmInputUpload(id: string) {
    const row = await this.repository.activateInput(id);
    return row ? present(row) : null;
  }

  async getById(id: string) {
    const row = await this.repository.get(id);
    return row ? present(row, row.output ? await new CosStorage().getDownloadUrl(row.output.objectKey) : null) : null;
  }
}

const videoExportService: VideoExportService = new PostgresVideoExportService();
export function getVideoExportService() { return videoExportService; }
