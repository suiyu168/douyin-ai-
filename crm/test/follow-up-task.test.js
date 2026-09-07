'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFollowUpTask, transitionFollowUpTask, approvalTaskDueAt, taskView } = require('../src/domain/follow-up-task');

const openTask = () => createFollowUpTask({
  id: 'task-1', customerId: 'customer-1', studentId: '', originType: 'manual', originId: '', ownerId: 'consultant-1',
  title: ' 电话确认 ', dueAt: '2026-09-08T02:00:00.000Z', status: 'completed',
});

test('creates an open task and ignores caller-owned status', () => {
  assert.deepEqual(openTask(), { id: 'task-1', customerId: 'customer-1', studentId: '', originType: 'manual', originId: '', ownerId: 'consultant-1', title: '电话确认', dueAt: '2026-09-08T02:00:00.000Z', status: 'open' });
});

test('allows only forward task transitions', () => {
  for (const status of ['in_progress', 'completed', 'cancelled']) assert.equal(transitionFollowUpTask(openTask(), status).status, status);
  const started = transitionFollowUpTask(openTask(), 'in_progress');
  for (const status of ['completed', 'cancelled']) assert.equal(transitionFollowUpTask(started, status).status, status);
  for (const [task, status] of [[started, 'open'], [transitionFollowUpTask(openTask(), 'completed'), 'open'], [openTask(), 'open'], [openTask(), 'unknown']]) {
    assert.throws(() => transitionFollowUpTask(task, status), { code: 'INVALID_TASK_TRANSITION' });
  }
});

test('derives approval due time and overdue at a strict instant boundary', () => {
  assert.equal(approvalTaskDueAt('2026-09-07T02:00:00.000Z'), '2026-09-08T02:00:00.000Z');
  assert.equal(taskView(openTask(), '2026-09-08T02:00:00.000Z').overdue, false);
  assert.equal(taskView(openTask(), '2026-09-08T02:00:00.001Z').overdue, true);
  assert.equal(taskView(transitionFollowUpTask(openTask(), 'completed'), '2026-09-09T00:00:00.000Z').overdue, false);
});

test('rejects malformed task records, origins, titles, and dates', () => {
  const base = { id: 't', customerId: 'c', studentId: '', originType: 'manual', originId: '', ownerId: 'u', title: 'call', dueAt: '2026-09-08T00:00:00.000Z' };
  for (const change of [{ title: '' }, { title: 'x'.repeat(201) }, { dueAt: 'bad' }, { originType: 'browser' }, { originType: 'enrollment_approval', originId: '' }]) {
    assert.throws(() => createFollowUpTask({ ...base, ...change }), { code: 'INVALID_FOLLOW_UP_TASK' });
  }
});
