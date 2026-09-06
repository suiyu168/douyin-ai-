'use strict';

const { DEMO_ACTORS } = require('../http/routes');

const REQUEST = 'chengqiyun-demo:v1';
const actor = DEMO_ACTORS['admin-1'];

function seedDemoData({ service }) {
  const customers = [
    { name: '演示学员一', phone: '13800000001', stage: '咨询中', nextFollowUpAt: '2030-01-10T09:00:00.000Z' },
    { name: '演示学员二', phone: '13800000002', stage: '待确认合同', nextFollowUpAt: '2030-01-12T09:00:00.000Z' },
    { name: '演示学员三', phone: '13800000003', stage: '分期跟进', nextFollowUpAt: '2030-01-15T09:00:00.000Z' }
  ].map((customer, index) => service.importCustomer({
    actor,
    requestId: `${REQUEST}:customer:${index + 1}`,
    customer: { ...customer, campusId: 'campus-a', teamId: 'team-a', ownerId: 'service-1', assignedTeacherId: 'teacher-1', notes: '仅用于本地虚构演示。' },
    source: { channel: 'local-fictional-demo', batch: 'seed-v1' }
  }).customer);

  const orders = [
    { customerId: customers[0].id, order: { listPriceCents: 980_000, discountCents: 80_000, discountApproved: true, dueAt: '2030-02-01T00:00:00.000Z', title: '虚构合同演示 A' } },
    { customerId: customers[1].id, order: { listPriceCents: 680_000, discountCents: 0, dueAt: '2030-02-10T00:00:00.000Z', title: '虚构合同演示 B' } },
    { customerId: customers[2].id, order: { listPriceCents: 1_280_000, discountCents: 0, dueAt: '2030-03-01T00:00:00.000Z', title: '虚构合同演示 C' } }
  ].map((item, index) => service.createOrder({
    actor,
    requestId: `${REQUEST}:order:${index + 1}`,
    customerId: item.customerId,
    order: item.order
  }).order);

  const ledgerEntries = [
    { orderId: orders[0].id, entry: { type: 'payment', idempotencyKey: `${REQUEST}:ledger:1`, amountCents: 300_000, status: 'confirmed', occurredAt: '2030-01-05T00:00:00.000Z' } },
    { orderId: orders[0].id, entry: { type: 'payment', idempotencyKey: `${REQUEST}:ledger:2`, amountCents: 300_000, status: 'pending', occurredAt: '2030-01-20T00:00:00.000Z' } },
    { orderId: orders[1].id, entry: { type: 'payment', idempotencyKey: `${REQUEST}:ledger:3`, amountCents: 120_000, status: 'confirmed', occurredAt: '2030-01-08T00:00:00.000Z' } }
  ];
  for (const [index, item] of ledgerEntries.entries()) service.appendPayment({
    actor,
    requestId: `${REQUEST}:ledger-write:${index + 1}`,
    orderId: item.orderId,
    entry: item.entry
  });

  const humanRequired = service.triageConversation({
    actor,
    requestId: `${REQUEST}:conversation:1`,
    customerId: customers[0].id,
    conversation: { message: '虚构风险演示：我想咨询退款流程，需要人工确认。', confidence: 0.99, citations: [] }
  }).conversation;

  return { customerIds: customers.map(customer => customer.id), orderIds: orders.map(order => order.id), conversationIds: [humanRequired.id] };
}

module.exports = { seedDemoData };
