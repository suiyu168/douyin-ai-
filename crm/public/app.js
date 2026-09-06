'use strict';

const numberFormat = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' });
const identity = document.querySelector('#demo-user');
const status = document.querySelector('#status');
const customerRows = document.querySelector('#customers');
const metricIds = { customerCount: 'customer-count', pendingHumanCount: 'pending-count', agreed: 'agreed', received: 'received', outstanding: 'outstanding' };
let loadGeneration = 0;

function request(path) { return fetch(path, { headers: { 'x-demo-user': identity.value, accept: 'application/json' }, cache: 'no-store' }).then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || '请求失败'); return data; }); }
function money(cents) { return numberFormat.format((Number.isSafeInteger(cents) ? cents : 0) / 100); }
function text(value) { return value == null || value === '' ? '—' : String(value); }
function renderCustomers(customers) {
  customerRows.replaceChildren();
  if (!customers.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = '暂无可见客户，请在客户模块导入虚构演示数据后查看。'; row.append(cell); customerRows.append(row); return; }
  for (const customer of customers) { const row = document.createElement('tr'); for (const value of [customer.name, customer.stage, customer.ownerId, customer.nextFollowUpAt, customer.phone]) { const cell = document.createElement('td'); cell.textContent = text(value); row.append(cell); } customerRows.append(row); }
}
function resetMetrics() { for (const id of Object.values(metricIds)) document.querySelector(`#${id}`).textContent = '—'; }
async function load() {
  const generation = ++loadGeneration;
  status.className = 'status'; status.textContent = '正在加载同源业务数据…'; resetMetrics(); customerRows.innerHTML = '<tr><td colspan="5">正在加载客户列表…</td></tr>';
  try {
    const [dashboard, customers] = await Promise.all([request('/api/dashboard'), request('/api/customers')]);
    if (generation !== loadGeneration) return;
    document.querySelector('#customer-count').textContent = text(dashboard.customerCount);
    document.querySelector('#pending-count').textContent = text(dashboard.pendingHumanCount);
    for (const key of ['agreed', 'received', 'outstanding']) document.querySelector(`#${metricIds[key]}`).textContent = money(dashboard.metrics?.[key]?.amountCents);
    renderCustomers(customers.customers || []); status.textContent = '数据已刷新。';
  } catch (error) { if (generation !== loadGeneration) return; resetMetrics(); customerRows.innerHTML = '<tr><td colspan="5">加载失败，请重新加载。</td></tr>'; status.className = 'status error'; status.textContent = `加载失败：${error.message}。请重新加载。`; }
}
document.querySelector('#retry').addEventListener('click', load); identity.addEventListener('change', load); load();
