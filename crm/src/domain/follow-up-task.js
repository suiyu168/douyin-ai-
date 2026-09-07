'use strict';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function ownRecord(value, code) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value')) fail(code);
  }
  return value;
}

function text(value, code, required = true, max = 200) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(code);
  return value.trim();
}

function milliseconds(value, code) {
  try {
    const intrinsic = Date.prototype.getTime.call(value);
    if (typeof intrinsic === 'number' && Number.isFinite(intrinsic)) return intrinsic;
  } catch {
    // Primitive date values may fall through to parsing below.
  }
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !value.trim())) fail(code);
  const time = Date.prototype.getTime.call(new Date(value));
  if (!Number.isFinite(time)) fail(code);
  return time;
}

const TRANSITIONS = Object.freeze({
  open: Object.freeze(['in_progress', 'completed', 'cancelled']),
  in_progress: Object.freeze(['completed', 'cancelled']),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

function createFollowUpTask(input) {
  ownRecord(input, 'INVALID_FOLLOW_UP_TASK');
  const task = {
    id: text(input.id, 'INVALID_FOLLOW_UP_TASK'),
    customerId: text(input.customerId, 'INVALID_FOLLOW_UP_TASK'),
    studentId: text(input.studentId ?? '', 'INVALID_FOLLOW_UP_TASK', false),
    originType: text(input.originType, 'INVALID_FOLLOW_UP_TASK'),
    originId: text(input.originId ?? '', 'INVALID_FOLLOW_UP_TASK', false),
    ownerId: text(input.ownerId, 'INVALID_FOLLOW_UP_TASK'),
    title: text(input.title, 'INVALID_FOLLOW_UP_TASK', true, 200),
    dueAt: text(input.dueAt, 'INVALID_FOLLOW_UP_TASK'),
    status: 'open',
  };
  if (!['manual', 'enrollment_approval'].includes(task.originType)) fail('INVALID_FOLLOW_UP_TASK');
  if (task.originType === 'manual' && task.originId) fail('INVALID_FOLLOW_UP_TASK');
  if (task.originType === 'enrollment_approval' && (!task.originId || !task.studentId)) fail('INVALID_FOLLOW_UP_TASK');
  milliseconds(task.dueAt, 'INVALID_FOLLOW_UP_TASK');
  return Object.freeze(task);
}

function transitionFollowUpTask(task, nextStatus) {
  ownRecord(task, 'INVALID_TASK_TRANSITION');
  if (!TRANSITIONS[task?.status]?.includes(nextStatus)) fail('INVALID_TASK_TRANSITION');
  return Object.freeze({ ...task, status: nextStatus });
}

function approvalTaskDueAt(approvedAt) {
  return new Date(milliseconds(approvedAt, 'INVALID_FOLLOW_UP_TASK') + 24 * 60 * 60 * 1000).toISOString();
}

function taskView(task, now) {
  ownRecord(task, 'INVALID_FOLLOW_UP_TASK');
  const overdue = ['open', 'in_progress'].includes(task.status)
    && milliseconds(task.dueAt, 'INVALID_FOLLOW_UP_TASK') < milliseconds(now, 'INVALID_FOLLOW_UP_TASK');
  return Object.freeze({ ...task, overdue });
}

module.exports = { createFollowUpTask, transitionFollowUpTask, approvalTaskDueAt, taskView };
