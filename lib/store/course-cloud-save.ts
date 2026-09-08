import { create } from 'zustand';

export type CourseCloudSaveStatus = 'unknown' | 'dirty' | 'saving' | 'saved' | 'failed';

interface CourseCloudSaveState {
  courseId: string | null;
  status: CourseCloudSaveStatus;
  selectCourse: (courseId: string | null) => void;
  setStatus: (courseId: string, status: CourseCloudSaveStatus) => void;
}

/**
 * Browser-session truth for whether the canvas currently shown has reached the
 * cloud. The database save_state only describes the last server snapshot and
 * cannot detect edits made since that snapshot.
 */
export const useCourseCloudSaveStore = create<CourseCloudSaveState>((set) => ({
  courseId: null,
  status: 'unknown',
  selectCourse: (courseId) =>
    set((state) => (state.courseId === courseId ? state : { courseId, status: 'unknown' })),
  setStatus: (courseId, status) =>
    set((state) => (state.courseId === courseId ? { status } : { courseId, status })),
}));
