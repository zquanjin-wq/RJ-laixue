import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const worker = (name: string) => readFileSync(resolve(process.cwd(), 'scripts', name), 'utf8');
const compose = () => readFileSync(resolve(process.cwd(), 'docker-compose.yml'), 'utf8');

describe('durable worker loop contracts', () => {
  it('runs video exports as an independently deployable leased agent', () => {
    const source = worker('run-course-video-export-agent.ts');
    expect(source).toContain('COURSE_VIDEO_EXPORT_WORKER_ID');
    expect(source).toContain('COURSE_VIDEO_EXPORT_LEASE_MS');
    expect(source).toContain('runNextCourseVideoExport({ workerId, leaseMs })');
    expect(source).toContain('COURSE_VIDEO_EXPORT_INTERVAL_MS must be at least 1000');
  });

  it('connects the video export worker to the renderer network', () => {
    const service = compose()
      .split(/^  video-export-worker:/m)[1]
      ?.split(/^  caddy:/m)[0];
    expect(service).toContain('networks:');
    expect(service).toContain('- default');
    expect(service).toContain('- render');
  });

  it('reserves host capacity in the 8-core / 16-GB renderer profile', () => {
    const service = compose()
      .split(/^  render-service:/m)[1]
      ?.split(/^  video-export-worker:/m)[0];
    expect(service).toContain('cpus: 6.0');
    expect(service).toContain('mem_limit: 10g');
    expect(service).toContain("RENDER_MAX_CONCURRENCY: '1'");
  });

  it('does not overlap revoice worker ticks', () => {
    const source = worker('run-course-revoice-worker.mjs');
    expect(source).toContain('for (;;)');
    expect(source).not.toContain('setInterval(');
  });

  it('allows a complete PPTX narration run to finish before timing out', () => {
    const source = worker('run-classroom-generation-agent.ts');
    expect(source).toContain('CLASSROOM_GENERATION_WORKER_ID');
    expect(source).toContain('runDurableClassroomOnce(getDatabasePool(), workerId, baseUrl)');
    expect(source).not.toContain('AbortSignal.timeout');
  });
});
