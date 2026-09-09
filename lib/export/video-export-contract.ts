export const VIDEO_EXPORT_API_VERSION = 'video-export/v1';

export type VideoExportFormat = 'mp4';
export type VideoExportStatus = 'queued' | 'rendering' | 'completed' | 'failed' | 'cancelled';

export interface VideoExportRequestInput {
  courseId: string;
  requestedBy: string;
  format: VideoExportFormat;
  sourceRevision?: number;
}

export interface VideoExportRecord {
  id: string;
  courseId: string;
  requestedBy: string;
  format: VideoExportFormat;
  status: VideoExportStatus;
  sourceRevision: number | null;
  downloadUrl: string | null;
  failureReason: string | null;
  progress: number | null;
  currentStage: string | null;
  framesRendered: number | null;
  totalFrames: number | null;
  /** One-based queue position, including active renders ahead of this job. */
  queuePosition: number | null;
  /** Historical estimate; null means the service has not observed enough completed renders yet. */
  estimatedWaitSeconds: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface VideoExportCapability {
  available: boolean;
  code: 'VIDEO_RENDERER_NOT_CONFIGURED';
  message: string;
}

export interface VideoExportRepository {
  create(input: VideoExportRequestInput): Promise<VideoExportRecord>;
  findById(id: string): Promise<VideoExportRecord | null>;
  listByCourse(courseId: string): Promise<VideoExportRecord[]>;
}
