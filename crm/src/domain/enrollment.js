'use strict';

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function ownRecord(value, code) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (!Object.hasOwn(descriptor, 'value')) fail(code);
  return value;
}
function value(input, key, code, required = false, max = 200) {
  const raw = Object.hasOwn(input, key) ? input[key] : '';
  if (typeof raw !== 'string' || raw.length > max || (required && !raw.trim())) fail(code);
  return raw.trim();
}
function requiredString(raw, code) {
  if (typeof raw !== 'string' || !raw.trim()) fail(code);
  return raw.trim();
}

function createEnrollmentApplication({ id, customerId, submittedBy, submittedAt, input }) {
  ownRecord(input, 'INVALID_ENROLLMENT');
  return Object.freeze({
    id: requiredString(id, 'INVALID_ENROLLMENT'), customerId: requiredString(customerId, 'INVALID_ENROLLMENT'), status: 'pending',
    currentEducation: value(input, 'currentEducation', 'INVALID_ENROLLMENT'),
    targetLevel: value(input, 'targetLevel', 'INVALID_ENROLLMENT', true),
    school: value(input, 'school', 'INVALID_ENROLLMENT', true),
    major: value(input, 'major', 'INVALID_ENROLLMENT', true),
    classType: value(input, 'classType', 'INVALID_ENROLLMENT'),
    submittedBy: requiredString(submittedBy, 'INVALID_ENROLLMENT'), submittedAt: requiredString(submittedAt, 'INVALID_ENROLLMENT'),
    decidedBy: '', decidedAt: '', rejectionReason: '',
  });
}

function decideEnrollmentApplication(enrollment, decision, actorId, decidedAt) {
  ownRecord(enrollment, 'INVALID_ENROLLMENT'); ownRecord(decision, 'INVALID_ENROLLMENT_DECISION');
  if (enrollment.status !== 'pending') fail('ENROLLMENT_ALREADY_DECIDED');
  if (!['approved', 'rejected'].includes(decision.status)) fail('INVALID_ENROLLMENT_DECISION');
  const rejectionReason = value(decision, 'reason', 'INVALID_ENROLLMENT_DECISION', decision.status === 'rejected', 500);
  if (decision.status === 'approved' && rejectionReason) fail('INVALID_ENROLLMENT_DECISION');
  return Object.freeze({ ...enrollment, status: decision.status, decidedBy: requiredString(actorId, 'INVALID_ENROLLMENT_DECISION'), decidedAt: requiredString(decidedAt, 'INVALID_ENROLLMENT_DECISION'), rejectionReason });
}

function createStudentRecord({ id, customerId, enrollmentId, createdAt }) {
  return Object.freeze({ id: requiredString(id, 'INVALID_STUDENT'), customerId: requiredString(customerId, 'INVALID_STUDENT'), enrollmentId: requiredString(enrollmentId, 'INVALID_STUDENT'), status: 'active', createdAt: requiredString(createdAt, 'INVALID_STUDENT') });
}

module.exports = { createEnrollmentApplication, decideEnrollmentApplication, createStudentRecord };
