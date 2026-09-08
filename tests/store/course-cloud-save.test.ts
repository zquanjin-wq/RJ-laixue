import { beforeEach, describe, expect, it } from 'vitest';
import { useCourseCloudSaveStore } from '@/lib/store/course-cloud-save';

describe('course cloud save state', () => {
  beforeEach(() => {
    useCourseCloudSaveStore.setState({ courseId: null, status: 'unknown' });
  });

  it('keeps state when the same course remounts across playback and edit chrome', () => {
    const store = useCourseCloudSaveStore.getState();
    store.selectCourse('course-1');
    store.setStatus('course-1', 'dirty');
    useCourseCloudSaveStore.getState().selectCourse('course-1');
    expect(useCourseCloudSaveStore.getState()).toMatchObject({
      courseId: 'course-1',
      status: 'dirty',
    });
  });

  it('resets stale state when navigating to another course', () => {
    const store = useCourseCloudSaveStore.getState();
    store.selectCourse('course-1');
    store.setStatus('course-1', 'failed');
    useCourseCloudSaveStore.getState().selectCourse('course-2');
    expect(useCourseCloudSaveStore.getState()).toMatchObject({
      courseId: 'course-2',
      status: 'unknown',
    });
  });
});
