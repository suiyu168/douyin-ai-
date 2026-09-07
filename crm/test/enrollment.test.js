'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createEnrollmentApplication,
  decideEnrollmentApplication,
  createStudentRecord,
} = require('../src/domain/enrollment');

const pending = () => createEnrollmentApplication({
  id: 'enrollment-1', customerId: 'customer-1', submittedBy: 'consultant-1',
  submittedAt: '2026-09-07T01:00:00.000Z',
  input: { currentEducation: ' 高中 ', targetLevel: ' 专升本 ', school: ' 虚构大学 ', major: ' 计算机 ', classType: ' 周末班 ' },
});

test('creates one normalized pending enrollment without caller-owned lifecycle fields', () => {
  const input = { currentEducation: ' 高中 ', targetLevel: ' 专升本 ', school: ' 虚构大学 ', major: ' 计算机 ', classType: ' 周末班 ', status: 'approved', decidedBy: 'browser' };
  const enrollment = createEnrollmentApplication({ id: 'enrollment-1', customerId: 'customer-1', submittedBy: 'consultant-1', submittedAt: '2026-09-07T01:00:00.000Z', input });
  assert.deepEqual(enrollment, {
    id: 'enrollment-1', customerId: 'customer-1', status: 'pending',
    currentEducation: '高中', targetLevel: '专升本', school: '虚构大学', major: '计算机', classType: '周末班',
    submittedBy: 'consultant-1', submittedAt: '2026-09-07T01:00:00.000Z', decidedBy: '', decidedAt: '', rejectionReason: '',
  });
  assert.equal(Object.isFrozen(enrollment), true);
  assert.equal(input.status, 'approved');
});

test('approves or rejects a pending enrollment exactly once', () => {
  assert.equal(decideEnrollmentApplication(pending(), { status: 'approved' }, 'supervisor-1', '2026-09-07T02:00:00.000Z').status, 'approved');
  const rejected = decideEnrollmentApplication(pending(), { status: 'rejected', reason: ' 信息不完整 ' }, 'supervisor-1', '2026-09-07T02:00:00.000Z');
  assert.equal(rejected.rejectionReason, '信息不完整');
  assert.throws(() => decideEnrollmentApplication(rejected, { status: 'approved' }, 'admin-1', '2026-09-07T03:00:00.000Z'), { code: 'ENROLLMENT_ALREADY_DECIDED' });
});

test('rejects malformed enrollment fields and decisions', () => {
  for (const input of [null, [], {}, { targetLevel: '本科', school: '', major: '计算机' }, { targetLevel: '本科', school: '学校', major: 'x'.repeat(201) }]) {
    assert.throws(() => createEnrollmentApplication({ id: 'e', customerId: 'c', submittedBy: 'u', submittedAt: '2026-09-07T01:00:00.000Z', input }), { code: 'INVALID_ENROLLMENT' });
  }
  for (const decision of [{ status: 'rejected' }, { status: 'approved', reason: 'browser reason' }, { status: 'pending' }, []]) {
    assert.throws(() => decideEnrollmentApplication(pending(), decision, 'supervisor-1', '2026-09-07T02:00:00.000Z'), { code: 'INVALID_ENROLLMENT_DECISION' });
  }
});

test('creates an active student that references but does not copy customer data', () => {
  assert.deepEqual(createStudentRecord({ id: 'student-1', customerId: 'customer-1', enrollmentId: 'enrollment-1', createdAt: '2026-09-07T02:00:00.000Z' }), {
    id: 'student-1', customerId: 'customer-1', enrollmentId: 'enrollment-1', status: 'active', createdAt: '2026-09-07T02:00:00.000Z',
  });
});
