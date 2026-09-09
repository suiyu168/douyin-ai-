'use strict';

const numberFormat = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const identity = document.querySelector('#demo-user');
const status = document.querySelector('#status');
const customerRows = document.querySelector('#customers');
const metricIds = { customerCount: 'customer-count', pendingHumanCount: 'pending-count', pendingEnrollmentCount: 'enrollment-count', studentCount: 'student-count', openTaskCount: 'task-count', overdueTaskCount: 'overdue-count', agreed: 'agreed', received: 'received', outstanding: 'outstanding' };
const enrollmentForm = document.querySelector('#enrollment-form');
const taskForm = document.querySelector('#task-form');
const workflowLists = ['enrollment-list', 'student-list', 'task-list'];
// Presentation hints only. The server owns identity and authorization for every request.
const demoRoles = { 'admin-1': 'admin', 'consultant-1': 'consultant', 'supervisor-1': 'supervisor', 'service-1': 'service', 'finance-1': 'finance' };
const stateLabels = { pending: '待审核', approved: '已通过', rejected: '已驳回', active: '在读', open: '待跟进', in_progress: '进行中', completed: '已完成', cancelled: '已取消' };
const errorMessages = { FORBIDDEN: '当前演示身份没有此操作权限', ENROLLMENT_PENDING: '该客户已有待审核报名，请先处理现有申请', STUDENT_EXISTS: '该客户已有学员档案，不能重复报名', ENROLLMENT_ALREADY_DECIDED: '该报名已处理，请刷新后查看', INVALID_TASK_TRANSITION: '任务状态已变化，请刷新后查看', INVALID_ENROLLMENT: '请检查报名信息', INVALID_ENROLLMENT_DECISION: '驳回时请填写原因', INVALID_FOLLOW_UP_TASK: '请检查任务标题和到期时间', NOT_FOUND: '记录已不可用，请重新加载' };
let loadGeneration = 0;
let loadController;
let loading = true;
let mutating = false;
let visibleCustomers = [];

function request(path, options = {}) {
  return fetch(path, { ...options, signal: options.method === 'POST' ? undefined : loadController?.signal, headers: { ...options.headers, 'x-demo-user': identity.value, accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' }).then(async response => {
    const data = await response.json();
    if (!response.ok) { const error = new Error('请求失败'); error.code = data.error?.code; throw error; }
    return data;
  });
}
function post(path, body) { return request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, requestId: crypto.randomUUID() }) }); }
function moduleResult(promise) { return promise.catch(error => { if (error.code === 'FORBIDDEN') return null; throw error; }); }
function element(tag, value, className) { const node = document.createElement(tag); if (value !== undefined) node.textContent = text(value); if (className) node.className = className; return node; }
function message(value, error = false) { status.className = error ? 'status error' : 'status'; status.textContent = value; }
function safeError(error) { return errorMessages[error.code] || '请求未能完成，请检查连接后重新加载确认结果'; }
function money(cents) { return numberFormat.format((Number.isSafeInteger(cents) ? cents : 0) / 100); }
function text(value) { return value == null || value === '' ? '—' : String(value); }
function displayPhone(value) {
  const phone = text(value);
  if (/^1[3-9]\d{9}$/.test(phone)) return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  return /^1\d{2}\*{4}\d{4}$/.test(phone) ? phone : phone === '—' ? phone : '****';
}
function displayDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? text(value) : dateFormat.format(date);
}
function time(value) {
  const node = document.createElement('time');
  const date = new Date(value);
  node.textContent = displayDate(value);
  if (value && !Number.isNaN(date.getTime())) node.dateTime = date.toISOString();
  return node;
}
function customerMessage(value) { const row = element('tr'); const cell = element('td', value); cell.colSpan = 5; row.append(cell); customerRows.replaceChildren(row); }
function renderCustomers(customers) {
  customerRows.replaceChildren();
  if (!customers.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = '暂无可见客户。演示数据将在首次启动时自动准备。'; row.append(cell); customerRows.append(row); return; }
  for (const customer of customers) { const row = document.createElement('tr'); for (const value of [customer.name, customer.stage, customer.ownerId, displayDate(customer.nextFollowUpAt), displayPhone(customer.phone)]) { const cell = document.createElement('td'); cell.textContent = text(value); row.append(cell); } customerRows.append(row); }
}
function resetMetrics() { for (const id of Object.values(metricIds)) document.querySelector(`#${id}`).textContent = '—'; }
function role() { return demoRoles[identity.value]; }
function canManageTasks() { return ['admin', 'supervisor', 'consultant', 'service'].includes(role()); }
function canManageTask(task) { return ['admin', 'supervisor'].includes(role()) || (canManageTasks() && task.ownerId === identity.value); }
function syncControls() {
  identity.disabled = mutating;
  document.querySelector('#retry').disabled = mutating;
  for (const form of [enrollmentForm, taskForm]) {
    for (const control of form.querySelectorAll('input, select, button')) control.disabled = loading || mutating || !form.querySelector('select').value;
  }
  for (const control of document.querySelectorAll('.workflow-actions input, .workflow-actions button')) control.disabled = loading || mutating;
}
function optionsFor(select, customers) {
  const previous = select.value;
  select.replaceChildren();
  if (!customers.length) { const option = element('option', '暂无可操作客户'); option.value = ''; select.append(option); return; }
  for (const customer of customers) { const option = element('option', customer.name); option.value = customer.id; select.append(option); }
  if (customers.some(customer => customer.id === previous)) select.value = previous;
}
function prepareForms(enrollments) {
  enrollmentForm.hidden = role() !== 'consultant';
  taskForm.hidden = !canManageTasks();
  const excluded = new Set((enrollments?.enrollments || []).filter(item => ['pending', 'approved'].includes(item.status)).map(item => item.customerId));
  const eligible = enrollments ? visibleCustomers.filter(customer => customer.ownerId === identity.value && !excluded.has(customer.id)) : [];
  optionsFor(enrollmentForm.querySelector('select'), eligible);
  optionsFor(taskForm.querySelector('select'), canManageTasks() ? visibleCustomers.filter(customer => ['admin', 'supervisor'].includes(role()) || customer.ownerId === identity.value) : []);
  document.querySelector('#enrollment-hint').textContent = eligible.length ? '提交后由主管或管理员审核；审核通过后自动建立学员和交接任务。' : '暂无可提交客户：已有待审核申请或学员的客户不能重复报名。';
  document.querySelector('#task-hint').textContent = taskForm.querySelector('select').value ? '任务自动归属客户负责人。' : '暂无可创建任务的客户。';
  document.querySelector('#workflow-role').textContent = role() === 'consultant' ? '顾问：提交自己的客户报名并跟进任务；学员档案由主管、管理员或授课老师查看。' : ['admin', 'supervisor'].includes(role()) ? '主管 / 管理员：审核可见报名、查看学员并管理跟进任务。' : role() === 'service' ? '客服：管理自己负责客户的跟进任务。报名与学员模块不可见。' : '财务：查看授权客户与财务指标，报名、学员和任务模块不可见。';
}
function card(title) { const node = element('article', undefined, 'workflow-card'); node.append(element('h4', title)); return node; }
function detail(node, label, value) { const row = element('p'); row.append(element('span', `${label}：`), element('span', value)); node.append(row); }
function datedDetail(node, label, value) { const row = element('p'); row.append(element('span', `${label}：`), time(value)); node.append(row); }
function renderList(id, data, key, render) {
  const list = document.querySelector(`#${id}`);
  list.replaceChildren();
  if (data === null) { list.append(element('p', '当前演示身份无权查看此模块。', 'workflow-note')); return; }
  const items = data[key] || [];
  if (!items.length) { list.append(element('p', '暂无记录。', 'workflow-note')); return; }
  for (const item of items) list.append(render(item));
}
function actionButton(label, onClick) { const button = element('button', label); button.type = 'button'; button.addEventListener('click', () => onClick(button)); return button; }
function renderEnrollment(enrollment) {
  const node = card(enrollment.customer?.name || enrollment.customerId);
  detail(node, '审核状态', stateLabels[enrollment.status] || enrollment.status);
  for (const [label, key] of [['当前学历', 'currentEducation'], ['目标层次', 'targetLevel'], ['学校', 'school'], ['专业', 'major'], ['班型', 'classType']]) detail(node, label, enrollment[key]);
  datedDetail(node, '提交时间', enrollment.submittedAt);
  if (enrollment.decidedAt) datedDetail(node, '审核时间', enrollment.decidedAt);
  if (enrollment.rejectionReason) detail(node, '驳回原因', enrollment.rejectionReason);
  if (enrollment.status === 'pending' && ['admin', 'supervisor'].includes(role())) {
    const actions = element('div', undefined, 'workflow-actions');
    const reasonLabel = element('label', '驳回原因（驳回时必填）');
    const reason = element('input'); reason.maxLength = 500; reasonLabel.append(reason);
    actions.append(reasonLabel,
      actionButton('通过报名', button => mutate(button, () => post('/api/enrollment-decisions', { enrollmentId: enrollment.id, decision: { status: 'approved' } }), '报名已通过，已建立学员及交接任务。')),
      actionButton('驳回报名', button => {
        if (!reason.value.trim()) { reason.setCustomValidity('请填写驳回原因'); reason.reportValidity(); reason.focus(); return; }
        return mutate(button, () => post('/api/enrollment-decisions', { enrollmentId: enrollment.id, decision: { status: 'rejected', reason: reason.value.trim() } }), '报名已驳回，顾问可修改信息后重新提交。');
      }));
    reason.addEventListener('input', () => reason.setCustomValidity(''));
    node.append(actions);
  }
  return node;
}
function renderStudent(student) {
  const node = card(student.customer?.name || student.customerId);
  detail(node, '学员编号', student.id); detail(node, '档案状态', stateLabels[student.status] || student.status);
  detail(node, '报名编号', student.enrollmentId); datedDetail(node, '建档时间', student.createdAt);
  return node;
}
function renderTask(task) {
  const node = card(task.title);
  detail(node, '客户', visibleCustomers.find(customer => customer.id === task.customerId)?.name || task.customerId);
  detail(node, '负责人', task.ownerId); detail(node, '状态', stateLabels[task.status] || task.status);
  detail(node, '来源', task.originType === 'enrollment_approval' ? '报名审核交接' : '手动创建');
  datedDetail(node, '到期时间', task.dueAt);
  if (task.overdue) node.append(element('p', '已逾期，请及时跟进。', 'overdue'));
  if (canManageTask(task)) {
    const actions = element('div', undefined, 'workflow-actions');
    const transitions = task.status === 'open' ? [['开始跟进', 'in_progress'], ['完成任务', 'completed'], ['取消任务', 'cancelled']] : task.status === 'in_progress' ? [['完成任务', 'completed'], ['取消任务', 'cancelled']] : [];
    for (const [label, nextStatus] of transitions) actions.append(actionButton(label, button => mutate(button, () => post('/api/follow-up-task-status', { taskId: task.id, status: nextStatus }), `任务已更新为${stateLabels[nextStatus]}。`)));
    node.append(actions);
  }
  return node;
}
async function mutate(button, operation, success, form) {
  if (loading || mutating) return;
  mutating = true; button.disabled = true; syncControls(); message('正在提交，请稍候…');
  try { await operation(); if (form) form.reset(); await load(success); }
  catch (error) { message(safeError(error), true); }
  finally { mutating = false; syncControls(); status.focus(); }
}
async function load(success = '数据已刷新。') {
  const generation = ++loadGeneration;
  loadController?.abort(); loadController = new AbortController(); loading = true;
  syncControls(); message('正在加载同源业务数据…'); resetMetrics(); customerMessage('正在加载客户列表…');
  for (const id of workflowLists) { const list = document.querySelector(`#${id}`); list.setAttribute('aria-busy', 'true'); list.replaceChildren(element('p', '正在加载…')); }
  try {
    const [dashboard, customers, enrollments, students, tasks] = await Promise.all([request('/api/dashboard'), request('/api/customers'), moduleResult(request('/api/enrollments')), moduleResult(request('/api/students')), moduleResult(request('/api/follow-up-tasks'))]);
    if (generation !== loadGeneration) return;
    for (const key of ['customerCount', 'pendingHumanCount', 'pendingEnrollmentCount', 'studentCount', 'openTaskCount', 'overdueTaskCount']) document.querySelector(`#${metricIds[key]}`).textContent = text(dashboard[key]);
    for (const key of ['agreed', 'received', 'outstanding']) document.querySelector(`#${metricIds[key]}`).textContent = money(dashboard.metrics?.[key]?.amountCents);
    visibleCustomers = customers.customers || []; renderCustomers(visibleCustomers); prepareForms(enrollments);
    renderList('enrollment-list', enrollments, 'enrollments', renderEnrollment);
    renderList('student-list', students, 'students', renderStudent);
    renderList('task-list', tasks, 'tasks', renderTask);
    loading = false; message(success);
  } catch (error) {
    if (generation !== loadGeneration) return;
    resetMetrics(); customerMessage('加载失败，请重新加载。');
    for (const id of workflowLists) document.querySelector(`#${id}`).replaceChildren(element('p', '加载失败，请重新加载。'));
    message(`${success !== '数据已刷新。' ? `${success}但列表刷新失败。` : '加载失败。'}${safeError(error)}`, true);
  } finally {
    if (generation === loadGeneration) { syncControls(); for (const id of workflowLists) document.querySelector(`#${id}`).setAttribute('aria-busy', 'false'); }
  }
}
enrollmentForm.addEventListener('submit', event => {
  event.preventDefault();
  const data = new FormData(enrollmentForm);
  const enrollment = {};
  for (const key of ['currentEducation', 'targetLevel', 'school', 'major', 'classType']) enrollment[key] = data.get(key).trim();
  return mutate(enrollmentForm.querySelector('button[type="submit"]'), () => post('/api/enrollments', { customerId: data.get('customerId'), enrollment }), '报名已提交，等待主管或管理员审核。', enrollmentForm);
});
taskForm.addEventListener('submit', event => {
  event.preventDefault();
  const data = new FormData(taskForm);
  const dueAt = new Date(data.get('dueAt'));
  if (Number.isNaN(dueAt.getTime())) { message('请填写有效的到期时间。', true); return; }
  return mutate(taskForm.querySelector('button[type="submit"]'), () => post('/api/follow-up-tasks', { customerId: data.get('customerId'), task: { title: data.get('title').trim(), dueAt: dueAt.toISOString() } }), '跟进任务已创建。', taskForm);
});
status.tabIndex = -1;
document.querySelector('#retry').addEventListener('click', () => load()); identity.addEventListener('change', () => load()); load();
for (const item of document.querySelectorAll('.nav-item[data-target]')) {
  item.addEventListener('click', () => {
    const target = document.querySelector(`#${item.dataset.target}`);
    if (!target) return;
    for (const navItem of document.querySelectorAll('.nav-item[data-target]')) {
      navItem.classList.toggle('active', navItem === item);
      if (navItem === item) navItem.setAttribute('aria-current', 'page'); else navItem.removeAttribute('aria-current');
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.focus({ preventScroll: true });
  });
}
