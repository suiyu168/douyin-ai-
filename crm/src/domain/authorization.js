'use strict';

const ROLES = Object.freeze(['admin', 'supervisor', 'service', 'consultant', 'teacher', 'finance']);

function nonBlank(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function own(object, key) {
  return object != null && Object.prototype.hasOwnProperty.call(object, key);
}

function validActor(actor) {
  return actor && own(actor, 'id') && own(actor, 'roles') && own(actor, 'campusIds') &&
    nonBlank(actor.id) && Array.isArray(actor.roles) && Array.isArray(actor.campusIds);
}

function campusMatches(actor, resource) {
  return own(resource, 'campusId') && nonBlank(resource.campusId) && actor.campusIds.includes(resource.campusId);
}

function ownerMatches(actor, resource) {
  return own(resource, 'ownerId') && nonBlank(resource.ownerId) && resource.ownerId === actor.id;
}

function roleAllows(actor, role, action, resource) {
  if (role === 'admin') {
    return ['organization.manage', 'customer.read', 'customer.write', 'customer.sensitive.read',
      'customer.phone.read', 'conversation.read', 'enrollment.read', 'enrollment.submit', 'enrollment.decide',
      'student.read', 'task.read', 'task.create', 'task.update', 'order.read', 'ledger.write'].includes(action);
  }
  if (role === 'supervisor') {
    return ['customer.read', 'customer.write', 'conversation.read', 'enrollment.read', 'enrollment.decide',
      'student.read', 'task.read', 'task.create', 'task.update'].includes(action) &&
      campusMatches(actor, resource) && own(actor, 'teamIds') && Array.isArray(actor.teamIds) &&
      own(resource, 'teamId') && nonBlank(resource.teamId) && actor.teamIds.includes(resource.teamId);
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
    return action === 'student.read' && campusMatches(actor, resource) &&
      own(resource, 'assignedTeacherId') && nonBlank(resource.assignedTeacherId) && resource.assignedTeacherId === actor.id;
  }
  if (role === 'finance') {
    return ['order.read', 'customer.read', 'customer.phone.read'].includes(action) && campusMatches(actor, resource);
  }
  return false;
}

function can(actor, action, resource) {
  if (!validActor(actor) || !nonBlank(action)) return false;
  return actor.roles.some((role) => roleAllows(actor, role, action, resource || {}));
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
  if (actor.roles.includes('finance') && !can(actor, 'conversation.read', customer)) {
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
