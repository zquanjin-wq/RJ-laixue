export const GLOBAL_COURSE_MANAGER_EMAIL = 'jinzengquan@ruijie.com.cn';

export function isGlobalCourseManager(email: string | null | undefined) {
  return email?.toLowerCase() === GLOBAL_COURSE_MANAGER_EMAIL;
}
