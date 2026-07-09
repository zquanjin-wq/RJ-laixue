'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  assignCourseToStudents,
  createStudent,
  importStudents,
  listCourseAssignments,
  listStudents,
  type CourseAssignmentRecord,
  type StudentRecord,
} from '@/lib/utils/cloud-sync';

interface LearningManagerProps {
  courseId: string;
  courseTitle: string;
  onClose: () => void;
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function parseStudentsCsv(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = '', email = '', employee_no = '', note = ''] = line
        .split(',')
        .map((part) => part.trim());
      return { name, email, employee_no, note };
    })
    .filter((student) => student.name);
}

function statusText(status: CourseAssignmentRecord['status']) {
  switch (status) {
    case 'completed':
      return '已学完';
    case 'in_progress':
      return '学习中';
    default:
      return '未学习';
  }
}

export function LearningManager({ courseId, courseTitle, onClose }: LearningManagerProps) {
  const [students, setStudents] = useState<StudentRecord[]>([]);
  const [assignments, setAssignments] = useState<CourseAssignmentRecord[]>([]);
  const [selectedStudentIds, setSelectedStudentIds] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [employeeNo, setEmployeeNo] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const assignedStudentIds = useMemo(
    () => new Set(assignments.map((assignment) => assignment.student_id)),
    [assignments],
  );

  const summary = useMemo(() => {
    const total = assignments.length;
    const completed = assignments.filter((a) => a.status === 'completed').length;
    const inProgress = assignments.filter((a) => a.status === 'in_progress').length;
    return {
      total,
      completed,
      inProgress,
      notStarted: Math.max(0, total - completed - inProgress),
    };
  }, [assignments]);

  const refresh = useCallback(async () => {
    try {
      setError('');
      const [studentData, assignmentData] = await Promise.all([
        listStudents(),
        listCourseAssignments(courseId),
      ]);
      setStudents(studentData);
      setAssignments(assignmentData);
    } catch (err: unknown) {
      setError(getErrorMessage(err, '加载学习数据失败'));
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreateStudent = async () => {
    setSaving(true);
    try {
      await createStudent({ name, email, employee_no: employeeNo });
      setName('');
      setEmail('');
      setEmployeeNo('');
      await refresh();
    } catch (err: unknown) {
      alert('新增学员失败：' + getErrorMessage(err, '未知错误'));
    } finally {
      setSaving(false);
    }
  };

  const handleBulkImport = async () => {
    const parsed = parseStudentsCsv(bulkText);
    if (parsed.length === 0) {
      alert('请按“姓名,邮箱,工号,备注”格式输入学员');
      return;
    }
    setSaving(true);
    try {
      await importStudents(parsed);
      setBulkText('');
      await refresh();
    } catch (err: unknown) {
      alert('批量导入失败：' + getErrorMessage(err, '未知错误'));
    } finally {
      setSaving(false);
    }
  };

  const handleAssign = async () => {
    const ids = Array.from(selectedStudentIds);
    if (ids.length === 0) {
      alert('请选择要分配的学员');
      return;
    }
    setSaving(true);
    try {
      await assignCourseToStudents(courseId, ids);
      setSelectedStudentIds(new Set());
      await refresh();
    } catch (err: unknown) {
      alert('课程分配失败：' + getErrorMessage(err, '未知错误'));
    } finally {
      setSaving(false);
    }
  };

  const handleCopyStudentLink = async (studentId: string) => {
    const url = `${window.location.origin}/classroom/${courseId}?share=1&student=${studentId}`;
    if (!navigator.clipboard?.writeText) {
      window.prompt('复制学员学习链接', url);
      return;
    }
    await navigator.clipboard.writeText(url);
    alert('学员学习链接已复制');
  };

  const toggleStudent = (studentId: string) => {
    setSelectedStudentIds((current) => {
      const next = new Set(current);
      if (next.has(studentId)) {
        next.delete(studentId);
      } else {
        next.add(studentId);
      }
      return next;
    });
  };

  return (
    <div className="mt-4 rounded-xl border bg-background/90 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">学习管理：{courseTitle || '未命名课程'}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            已分配 {summary.total} 人，已学完 {summary.completed} 人，学习中{' '}
            {summary.inProgress} 人，未学习 {summary.notStarted} 人
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          关闭
        </button>
      </div>

      {loading ? (
        <div className="mt-4 text-sm text-muted-foreground">正在加载学习数据...</div>
      ) : error ? (
        <div className="mt-4 text-sm text-destructive">{error}</div>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.2fr]">
          <section className="rounded-lg border p-3">
            <h4 className="text-sm font-medium">学员维护</h4>
            <div className="mt-3 grid gap-2">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="姓名"
                className="rounded border bg-background px-3 py-2 text-sm"
              />
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="邮箱，可选"
                className="rounded border bg-background px-3 py-2 text-sm"
              />
              <input
                value={employeeNo}
                onChange={(event) => setEmployeeNo(event.target.value)}
                placeholder="工号，可选"
                className="rounded border bg-background px-3 py-2 text-sm"
              />
              <button
                onClick={handleCreateStudent}
                disabled={saving || !name.trim()}
                className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
              >
                新增学员
              </button>
            </div>

            <textarea
              value={bulkText}
              onChange={(event) => setBulkText(event.target.value)}
              placeholder={'批量导入：每行 姓名,邮箱,工号,备注\n例如：张三,zhangsan@example.com,10001,销售一部'}
              className="mt-4 min-h-24 w-full rounded border bg-background px-3 py-2 text-sm"
            />
            <button
              onClick={handleBulkImport}
              disabled={saving || !bulkText.trim()}
              className="mt-2 rounded border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
            >
              批量导入学员
            </button>
          </section>

          <section className="rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium">分配与学习情况</h4>
              <button
                onClick={handleAssign}
                disabled={saving || selectedStudentIds.size === 0}
                className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
              >
                分配选中学员
              </button>
            </div>

            <div className="mt-3 max-h-72 overflow-auto rounded border">
              {students.length === 0 ? (
                <div className="p-3 text-sm text-muted-foreground">暂无学员，请先新增或导入。</div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      <th className="p-2">选择</th>
                      <th className="p-2">学员</th>
                      <th className="p-2">工号/邮箱</th>
                      <th className="p-2">状态</th>
                      <th className="p-2">链接</th>
                    </tr>
                  </thead>
                  <tbody>
                    {students.map((student) => {
                      const assignment = assignments.find((item) => item.student_id === student.id);
                      const alreadyAssigned = assignedStudentIds.has(student.id);
                      return (
                        <tr key={student.id} className="border-t">
                          <td className="p-2">
                            <input
                              type="checkbox"
                              checked={selectedStudentIds.has(student.id)}
                              disabled={alreadyAssigned}
                              onChange={() => toggleStudent(student.id)}
                            />
                          </td>
                          <td className="p-2 font-medium">{student.name}</td>
                          <td className="p-2 text-muted-foreground">
                            {student.employee_no || student.email || '-'}
                          </td>
                          <td className="p-2">
                            {assignment ? statusText(assignment.status) : '未分配'}
                          </td>
                          <td className="p-2">
                            {assignment ? (
                              <button
                                onClick={() => handleCopyStudentLink(student.id)}
                                className="rounded border px-2 py-1 text-[11px] hover:bg-muted"
                              >
                                复制
                              </button>
                            ) : (
                              '-'
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
