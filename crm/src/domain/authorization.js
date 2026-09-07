'use strict';

const ROLES = Object.freeze(['admin', 'supervisor', 'service', 'consultant', 'teacher', 'finance']);

function nonBlank(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function own(object, key) {
  try {
    return object != null && Object.prototype.hasOwnProperty.call(object, key);
  } catch {
    return false;
  }
}

function ownDataValue(object, key) {
  if (object == null || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && own(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function readStringArray(value) {
  try {
    if (!Array.isArray(value)) return null;
    const length = ownDataValue(value, 'length');
    if (!Number.isSafeInteger(length) || length < 0) return null;
    const values = [];
    for (let index = 0; index < length; index += 1) {
      const item = ownDataValue(value, String(index));
      if (!nonBlank(item)) return null;
      values.push(item);
    }
    return values;
  } catch {
    return null;
  }
}

function readActor(actor) {
  const id = ownDataValue(actor, 'id');
  const roles = readStringArray(ownDataValue(actor, 'roles'));
  const campusIds = readStringArray(ownDataValue(actor, 'campusIds'));
  if (!nonBlank(id) || roles === null || campusIds === null) return null;
  return { id, roles, campusIds, teamIds: readStringArray(ownDataValue(actor, 'teamIds')) };
}

function campusMatches(actor, resource) {
  const campusId = ownDataValue(resource, 'campusId');
  return nonBlank(campusId) && Array.prototype.includes.call(actor.campusIds, campusId);
}

function ownerMatches(actor, resource) {
  const ownerId = ownDataValue(resource, 'ownerId');
  return nonBlank(ownerId) && ownerId === actor.id;
}

function roleAllows(actor, role, action, resource) {
  if (role === 'admin') {
    return ['organization.manage', 'customer.read', 'customer.write', 'customer.sensitive.read',
      'customer.phone.read', 'conversation.read', 'enrollment.read', 'enrollment.submit', 'enrollment.decide',
      'student.read', 'task.read', 'task.create', 'task.update', 'order.read', 'ledger.write'].includes(action);
  }
  if (role === 'supervisor') {
    const teamId = ownDataValue(resource, 'teamId');
    return ['customer.read', 'customer.write', 'conversation.read', 'enrollment.read', 'enrollment.decide',
      'student.read', 'task.read', 'task.create', 'task.update'].includes(action) &&
      campusMatches(actor, resource) && actor.teamIds !== null &&
      nonBlank(teamId) && Array.prototype.includes.call(actor.teamIds, teamId);
  }
  if (role === 'service') {
    return ['customer.read', 'customer.write', 'conversation.read', 'task.read', 'task.create', 'task.update'].includes(action) &&
      campusMatches(actor, resource) && ownerMatches(actor, resource);
  }
  if (role === 'consultant') {
    return ['customer.read', 'customer.write', 'conversation.read', 'enrollment.read', 'enrollment.submit',
      'task.read', 'task.create', 'task.update'].includes(action) &&
      campusMatches(actor, resource) && ownerMatches(actor, resource);
  }
  if (role === 'teacher') {
    const assignedTeacherId = ownDataValue(resource, 'assignedTeacherId');
    return action === 'student.read' && campusMatches(actor, resource) &&
      nonBlank(assignedTeacherId) && assignedTeacherId === actor.id;
  }
  if (role === 'finance') {
    return ['order.read', 'customer.read', 'customer.phone.read'].includes(action) && campusMatches(actor, resource);
  }
  return false;
}

function can(actor, action, resource) {
  try {
    const trustedActor = readActor(actor);
    if (!trustedActor || !nonBlank(action)) return false;
    return Array.prototype.some.call(trustedActor.roles, (role) => roleAllows(trustedActor, role, action, resource || {}));
  } catch {
    return false;
  }
}

function assertAllowed(actor, action, resource) {
  if (!can(actor, action, resource)) {
    const error = new Error(`Forbidden action: ${action}`);
    error.code = 'FORBIDDEN';
    throw error;
  }
}

function maskPhone(phone) {
  if (phone === '') return '';
  if (typeof phone !== 'string' || !/^1[3-9]\d{9}$/.test(phone)) return '****';
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function maskIdNumber(idNumber) {
  if (idNumber === '') return '';
  if (typeof idNumber !== 'string' || idNumber.length < 4) return '****';
  return `**************${idNumber.slice(-4)}`;
}

function maskSensitiveCustomer(customer, actor) {
  assertAllowed(actor, 'customer.read', customer);
  const view = { ...customer };
  if (can(actor, 'customer.sensitive.read', customer)) {
    if (view.phone == null) view.phone = '';
    if (view.idNumber == null) view.idNumber = '';
    return view;
  }
  if (Array.prototype.includes.call(readActor(actor)?.roles || [], 'finance') && !can(actor, 'conversation.read', customer)) {
    return {
      id: customer.id,
      name: customer.name,
      phone: customer.phone ?? '',
      idNumber: maskIdNumber(customer.idNumber ?? ''),
      campusId: customer.campusId,
      teamId: customer.teamId,
      ownerId: customer.ownerId,
    };
  }
  view.phone = can(actor, 'customer.phone.read', customer) ? (customer.phone ?? '') : maskPhone(customer.phone ?? '');
  view.idNumber = maskIdNumber(customer.idNumber ?? '');
  return view;
}

function maskModuleCustomerSummary(customer, actor, action) {
  if (!['enrollment.read', 'student.read', 'task.read'].includes(action)) {
    assertAllowed(actor, '__invalid_summary_action__', customer);
  }
  assertAllowed(actor, action, customer);
  return Object.freeze({
    id: customer.id,
    name: customer.name,
    maskedPhone: maskPhone(customer.phone ?? ''),
    campusId: customer.campusId,
    teamId: customer.teamId,
    assignedTeacherId: customer.assignedTeacherId ?? '',
  });
}

module.exports = { ROLES, can, assertAllowed, maskSensitiveCustomer, maskModuleCustomerSummary };
