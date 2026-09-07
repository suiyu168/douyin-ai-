const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ROLES,
  can,
  assertAllowed,
  maskSensitiveCustomer,
  maskModuleCustomerSummary,
} = require('../src/domain/authorization');

const actor = (roles, extra = {}) => ({ id: 'u-1', roles, campusIds: ['campus-a'], ...extra });
const resource = (extra = {}) => ({ ownerId: 'u-1', teamId: 'team-a', campusId: 'campus-a', assignedTeacherId: 'u-1', ...extra });

test('exports the frozen six-role list', () => {
  assert.deepEqual(ROLES, ['admin', 'supervisor', 'service', 'consultant', 'teacher', 'finance']);
  assert.ok(Object.isFrozen(ROLES));
});

test('admin allows listed actions globally but denies unknown actions', () => {
  const a = actor(['admin'], { campusIds: [] });
  for (const action of ['organization.manage', 'customer.read', 'customer.write', 'customer.sensitive.read', 'customer.phone.read', 'conversation.read', 'student.read', 'order.read', 'ledger.write']) assert.equal(can(a, action, {}), true);
  assert.equal(can(a, 'customer.delete', {}), false);
});

test('supervisor requires matching campus and team', () => {
  const a = actor(['supervisor'], { teamIds: ['team-a'] });
  for (const action of ['customer.read', 'customer.write', 'conversation.read']) assert.equal(can(a, action, resource()), true);
  assert.equal(can(a, 'customer.read', resource({ campusId: 'campus-b' })), false);
  assert.equal(can(a, 'customer.read', resource({ teamId: 'team-b' })), false);
});

test('service requires matching campus and owner', () => {
  const a = actor(['service']);
  assert.equal(can(a, 'customer.read', resource()), true);
  assert.equal(can(a, 'ledger.write', resource()), false);
  assert.equal(can(a, 'conversation.read', resource({ ownerId: 'u-2' })), false);
  assert.equal(can(a, 'customer.write', resource({ campusId: 'campus-b' })), false);
});

test('consultant requires matching campus and assigned owner', () => {
  const a = actor(['consultant']);
  assert.equal(can(a, 'customer.write', resource()), true);
  assert.equal(can(a, 'ledger.write', resource()), false);
  assert.equal(can(a, 'customer.read', resource({ ownerId: 'u-2' })), false);
  assert.equal(can(a, 'conversation.read', resource({ campusId: 'campus-b' })), false);
});

test('teacher reads only assigned students on matching campus', () => {
  const a = actor(['teacher']);
  assert.equal(can(a, 'student.read', resource()), true);
  assert.equal(can(a, 'student.read', resource({ assignedTeacherId: 'u-2' })), false);
  assert.equal(can(a, 'student.read', resource({ campusId: 'campus-b' })), false);
  assert.equal(can(a, 'customer.read', resource()), false);
});

test('enrollment actions separate submission from scoped approval', () => {
  const own = { id: 'c', campusId: 'campus-a', teamId: 'team-a', ownerId: 'consultant-1', assignedTeacherId: 'teacher-1' };
  assert.equal(can(actor(['consultant'], { id: 'consultant-1' }), 'enrollment.submit', own), true);
  assert.equal(can(actor(['consultant'], { id: 'consultant-1' }), 'enrollment.decide', own), false);
  assert.equal(can(actor(['supervisor'], { id: 'supervisor-1', teamIds: ['team-a'] }), 'enrollment.decide', own), true);
  assert.equal(can(actor(['supervisor'], { id: 'supervisor-1', teamIds: ['team-b'] }), 'enrollment.decide', own), false);
  assert.equal(can(actor(['service'], { id: 'consultant-1' }), 'enrollment.submit', own), false);
});

test('task actions allow scoped supervisors and the customer owner only', () => {
  const own = { campusId: 'campus-a', teamId: 'team-a', ownerId: 'consultant-1' };
  for (const role of ['consultant', 'service']) assert.equal(can(actor([role], { id: 'consultant-1' }), 'task.update', own), true);
  assert.equal(can(actor(['consultant'], { id: 'other' }), 'task.update', own), false);
  assert.equal(can(actor(['finance'], { id: 'finance-1' }), 'task.read', own), false);
});

test('student summaries require student.read and always mask the phone', () => {
  const customer = { id: 'c', name: '虚构客户', phone: '13800138000', idNumber: '110101199001011234', wechat: 'secret', notes: 'private', campusId: 'campus-a', teamId: 'team-a', ownerId: 'consultant-1', assignedTeacherId: 'teacher-1' };
  assert.deepEqual(maskModuleCustomerSummary(customer, actor(['teacher'], { id: 'teacher-1' }), 'student.read'), {
    id: 'c', name: '虚构客户', maskedPhone: '138****8000', campusId: 'campus-a', teamId: 'team-a', assignedTeacherId: 'teacher-1',
  });
  assert.throws(() => maskModuleCustomerSummary(customer, actor(['finance'], { id: 'finance-1' }), 'student.read'), { code: 'FORBIDDEN' });
});

test('new action matrix grants only the stated role and scoped resource combinations', () => {
  const scoped = resource({ ownerId: 'consultant-1', assignedTeacherId: 'teacher-1' });
  const supervisor = actor(['supervisor'], { id: 'supervisor-1', teamIds: ['team-a'] });
  const consultant = actor(['consultant'], { id: 'consultant-1' });
  const service = actor(['service'], { id: 'consultant-1' });
  const teacher = actor(['teacher'], { id: 'teacher-1' });
  const finance = actor(['finance'], { id: 'finance-1' });

  for (const action of ['enrollment.read', 'enrollment.decide', 'student.read', 'task.read', 'task.create', 'task.update']) assert.equal(can(supervisor, action, scoped), true);
  for (const action of ['enrollment.read', 'enrollment.submit', 'task.read', 'task.create', 'task.update']) assert.equal(can(consultant, action, scoped), true);
  for (const action of ['task.read', 'task.create', 'task.update']) assert.equal(can(service, action, scoped), true);
  assert.equal(can(teacher, 'student.read', scoped), true);
  for (const action of ['enrollment.submit', 'student.read', 'task.read', 'task.create', 'task.update']) assert.equal(can(supervisor, action, resource({ campusId: 'campus-b', ownerId: 'consultant-1', assignedTeacherId: 'teacher-1' })), false);
  for (const action of ['enrollment.read', 'enrollment.submit', 'student.read', 'task.read', 'task.create', 'task.update']) assert.equal(can(finance, action, scoped), false);
});

test('finance reads orders/customers and phone only in matching campus', () => {
  const a = actor(['finance']);
  for (const action of ['order.read', 'customer.read', 'customer.phone.read']) assert.equal(can(a, action, resource()), true);
  for (const action of ['conversation.read', 'customer.write', 'customer.sensitive.read', 'organization.manage', 'ledger.write']) assert.equal(can(a, action, resource()), false);
  assert.equal(can(a, 'order.read', resource({ campusId: 'campus-b' })), false);
});

test('multiple roles require one complete role rule and unknown roles/actions deny', () => {
  const a = actor(['service', 'teacher'], { teamIds: [] });
  assert.equal(can(a, 'customer.read', resource({ ownerId: 'u-2' })), false);
  assert.equal(can(a, 'student.read', resource()), true);
  assert.equal(can(actor(['wat']), 'customer.read', resource()), false);
  assert.equal(can(actor(['admin']), 'wat', resource()), false);
});

test('malformed actors and missing resource scope never match', () => {
  assert.equal(can({ roles: ['admin'] }, 'customer.read', {}), false);
  assert.equal(can({ id: 'u-1', roles: ['service'], campusIds: [] }, 'customer.read', resource()), false);
  assert.equal(can(actor(['service']), 'customer.read', { ownerId: 'u-1' }), false);
  assert.equal(can(actor(['supervisor'], { teamIds: [] }), 'customer.read', resource()), false);
});

test('authorization ignores caller-overridden role and scope array methods', () => {
  const noRoles = actor([]);
  Object.defineProperty(noRoles.roles, 'some', { value: () => true });
  const wrongCampus = actor(['service'], { campusIds: ['campus-b'] });
  Object.defineProperty(wrongCampus.campusIds, 'includes', { value: () => true });
  const wrongTeam = actor(['supervisor'], { teamIds: ['team-b'] });
  Object.defineProperty(wrongTeam.teamIds, 'includes', { value: () => true });

  assert.deepEqual([
    can(noRoles, 'customer.read', resource()),
    can(wrongCampus, 'customer.read', resource()),
    can(wrongTeam, 'customer.read', resource()),
  ], [false, false, false]);
});

test('authorization rejects non-string array entries and accessor-based identity or scope', () => {
  const malformedRoles = actor(['admin', 1]);
  const malformedCampuses = actor(['service'], { campusIds: ['campus-a', 1] });
  const accessorId = actor(['service']);
  Object.defineProperty(accessorId, 'id', { get: () => 'u-1' });
  const accessorOwner = resource();
  Object.defineProperty(accessorOwner, 'ownerId', { get: () => 'u-1' });
  const accessorTeacher = resource();
  Object.defineProperty(accessorTeacher, 'assignedTeacherId', { get: () => 'u-1' });

  assert.deepEqual([
    can(malformedRoles, 'customer.read', resource()),
    can(malformedCampuses, 'customer.read', resource()),
    can(accessorId, 'customer.read', resource()),
    can(actor(['service']), 'customer.read', accessorOwner),
    can(actor(['teacher']), 'student.read', accessorTeacher),
  ], [false, false, false, false, false]);
});

test('assertAllowed throws safe FORBIDDEN error naming action', () => {
  assert.doesNotThrow(() => assertAllowed(actor(['service']), 'customer.read', resource()));
  assert.throws(() => assertAllowed(actor(['service']), 'customer.read', resource({ ownerId: 'u-2' })), (error) => error.code === 'FORBIDDEN' && error.message.includes('customer.read') && !error.message.includes('u-2'));
});

const customer = { id: 'cust-1', phone: '13800138000', idNumber: 'ABCDEF1234', name: 'Fictional', campusId: 'campus-a', ownerId: 'u-1' };
test('masking returns an immutable shallow view by viewer privilege', () => {
  const adminView = maskSensitiveCustomer(customer, actor(['admin']));
  assert.deepEqual(adminView, customer);
  assert.notStrictEqual(adminView, customer);
  const phoneView = maskSensitiveCustomer(customer, actor(['finance']));
  assert.equal(phoneView.phone, customer.phone);
  assert.equal(phoneView.idNumber, '**************1234');
  const normalView = maskSensitiveCustomer(customer, actor(['service']));
  assert.equal(normalView.phone, '138****8000');
  assert.equal(normalView.idNumber, '**************1234');
  assert.equal(customer.phone, '13800138000');
});

test('finance-only masking returns only reconciliation identifiers and masked sensitive data', () => {
  const fullCustomer = {
    id: 'cust-finance-1',
    name: 'Finance Fictional',
    phone: '13800138000',
    idNumber: 'ABCDEF1234',
    campusId: 'campus-a',
    teamId: 'team-a',
    ownerId: 'u-1',
    notes: 'do not disclose',
    stage: 'negotiating',
    wechat: 'private-wechat',
    assignedTeacherId: 'teacher-1',
    nextFollowUpAt: '2030-01-01T00:00:00.000Z',
    arbitraryInternalField: 'not part of the finance contract',
  };

  assert.deepEqual(maskSensitiveCustomer(fullCustomer, actor(['finance'])), {
    id: 'cust-finance-1',
    name: 'Finance Fictional',
    phone: '13800138000',
    idNumber: '**************1234',
    campusId: 'campus-a',
    teamId: 'team-a',
    ownerId: 'u-1',
  });
});

test('admin and conversation-capable service-finance viewers retain their existing customer views', () => {
  const fullCustomer = {
    id: 'cust-union-1',
    name: 'Union Fictional',
    phone: '13800138000',
    idNumber: 'ABCDEF1234',
    campusId: 'campus-a',
    teamId: 'team-a',
    ownerId: 'u-1',
    notes: 'service may see this',
    stage: 'follow-up',
    wechat: 'service-wechat',
    assignedTeacherId: 'teacher-1',
    nextFollowUpAt: '2030-01-01T00:00:00.000Z',
  };
  const serviceView = { ...fullCustomer, phone: '138****8000', idNumber: '**************1234' };
  const serviceFinanceView = { ...fullCustomer, idNumber: '**************1234' };

  assert.deepEqual(maskSensitiveCustomer(fullCustomer, actor(['admin'])), fullCustomer);
  assert.deepEqual(maskSensitiveCustomer(fullCustomer, actor(['service'])), serviceView);
  assert.deepEqual(maskSensitiveCustomer(fullCustomer, actor(['service', 'finance'])), serviceFinanceView);
});

test('masking preserves empty values and fully masks short/invalid values', () => {
  const view = maskSensitiveCustomer({ phone: '', idNumber: '12', campusId: 'campus-a', ownerId: 'u-1' }, actor(['service']));
  assert.equal(view.phone, '');
  assert.equal(view.idNumber, '****');
  assert.equal(maskSensitiveCustomer({ phone: '123', idNumber: '123', campusId: 'campus-a', ownerId: 'u-1' }, actor(['service'])).phone, '****');
});

test('masking fully masks non-mobile phone values even when long enough', () => {
  for (const phone of ['abcdefghijk', '13800138']) {
    const view = maskSensitiveCustomer({ phone, idNumber: '', campusId: 'campus-a', ownerId: 'u-1' }, actor(['service']));
    assert.equal(view.phone, '****');
  }
});

test('masking treats numeric and boolean sensitive values as invalid, not missing', () => {
  const phoneZero = maskSensitiveCustomer({ phone: 0, idNumber: '', campusId: 'campus-a', ownerId: 'u-1' }, actor(['service']));
  const phoneFalse = maskSensitiveCustomer({ phone: false, idNumber: '', campusId: 'campus-a', ownerId: 'u-1' }, actor(['service']));
  const idZero = maskSensitiveCustomer({ phone: '', idNumber: 0, campusId: 'campus-a', ownerId: 'u-1' }, actor(['service']));
  const idFalse = maskSensitiveCustomer({ phone: '', idNumber: false, campusId: 'campus-a', ownerId: 'u-1' }, actor(['service']));
  assert.equal(phoneZero.phone, '****');
  assert.equal(phoneFalse.phone, '****');
  assert.equal(idZero.idNumber, '****');
  assert.equal(idFalse.idNumber, '****');
});

test('admin masking normalizes only nullish sensitive fields without mutating input', () => {
  const input = { phone: null, idNumber: undefined };
  const view = maskSensitiveCustomer(input, actor(['admin']));
  assert.equal(view.phone, '');
  assert.equal(view.idNumber, '');
  assert.ok(Object.prototype.hasOwnProperty.call(input, 'idNumber'));
  assert.equal(input.phone, null);
  assert.equal(input.idNumber, undefined);

  const preserved = maskSensitiveCustomer({ phone: '', idNumber: '', campusId: 'campus-a' }, actor(['admin']));
  assert.equal(preserved.phone, '');
  assert.equal(preserved.idNumber, '');
  const unusual = maskSensitiveCustomer({ phone: 0, idNumber: false, campusId: 'campus-a' }, actor(['admin']));
  assert.equal(unusual.phone, 0);
  assert.equal(unusual.idNumber, false);
});

test('inherited resource scope fields never authorize access', () => {
  const serviceResource = Object.create({ campusId: 'campus-a', ownerId: 'u-1' });
  const supervisorResource = Object.create({ campusId: 'campus-a', teamId: 'team-a' });
  const teacherResource = Object.create({ campusId: 'campus-a', assignedTeacherId: 'u-1' });
  const financeResource = Object.create({ campusId: 'campus-a' });
  assert.equal(can(actor(['service']), 'customer.read', serviceResource), false);
  assert.equal(can(actor(['supervisor'], { teamIds: ['team-a'] }), 'customer.read', supervisorResource), false);
  assert.equal(can(actor(['teacher']), 'student.read', teacherResource), false);
  assert.equal(can(actor(['finance']), 'order.read', financeResource), false);
});

test('masking rejects viewers outside customer scope', () => {
  assert.throws(() => maskSensitiveCustomer({ ...customer, campusId: 'campus-b', ownerId: 'u-2' }, actor(['service'])), (error) => error.code === 'FORBIDDEN');
});
