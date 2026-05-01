const test = require('node:test');
const assert = require('node:assert/strict');

const {
  auditRecentOrderNotifications,
  buildOrderNotificationAudit,
  normalizeLedgerOrder,
} = require('../server/services/orderNotificationAuditService');

function paidOrder(orderNo, orderedAt, amount) {
  return {
    orderNo,
    wtime: orderedAt,
    totalPaymentPrice: amount,
    totalRefundedPrice: 0,
    payments: [
      {
        paidPrice: amount,
        paymentStatus: 'PAID',
        paymentCompleteTime: orderedAt,
        method: 'CARD',
      },
    ],
  };
}

test('normalizeLedgerOrder treats ledger cash totals and Imweb payments as auditable financial activity', () => {
  const order = normalizeLedgerOrder({
    order_no: '202604304098628',
    ordered_at: '2026-04-30T07:40:15.000Z',
    approved_amount: '239000',
    refunded_amount: '0',
    raw: paidOrder('202604304098628', '2026-04-30T07:40:15.000Z', 239000),
    last_seen_scan_id: 'scan-1',
    last_seen_at: '2026-04-30T07:45:00.000Z',
  });

  assert.equal(order.orderNo, '202604304098628');
  assert.equal(order.orderDate, '2026-04-30');
  assert.equal(order.approvedAmount, 239000);
  assert.equal(order.refundedAmount, 0);
  assert.equal(order.transactionCount, 1);
  assert.equal(order.hasFinancialActivity, true);
});

test('buildOrderNotificationAudit flags financial Imweb orders without recorded Telegram delivery', () => {
  const audit = buildOrderNotificationAudit([
    {
      order_no: 'paid-missing',
      ordered_at: '2026-04-30T07:40:15.000Z',
      approved_amount: '239000',
      refunded_amount: '0',
      raw: paidOrder('paid-missing', '2026-04-30T07:40:15.000Z', 239000),
    },
    {
      order_no: 'paid-ok',
      ordered_at: '2026-04-30T06:45:17.000Z',
      approved_amount: '158000',
      refunded_amount: '0',
      raw: paidOrder('paid-ok', '2026-04-30T06:45:17.000Z', 158000),
    },
    {
      order_no: 'unpaid-skip',
      ordered_at: '2026-04-30T05:00:00.000Z',
      approved_amount: '0',
      refunded_amount: '0',
      raw: {
        orderNo: 'unpaid-skip',
        wtime: '2026-04-30T05:00:00.000Z',
        totalPaymentPrice: 0,
        totalRefundedPrice: 0,
        payments: [],
      },
    },
  ], {
    getDiagnostics: orderNo => {
      if (orderNo === 'paid-ok') {
        return {
          notificationRecorded: true,
          notification: {
            notificationStage: 'payment_confirmed',
            messageId: 4321,
          },
          importedOrder: null,
        };
      }

      return {
        notificationRecorded: false,
        notification: null,
        importedOrder: null,
      };
    },
  });

  assert.equal(audit.status, 'failed');
  assert.deepEqual(audit.summary, {
    totalRows: 3,
    checkedOrders: 2,
    skippedOrders: 1,
    missingDeliveryCount: 1,
    staleNotificationCount: 0,
  });
  assert.deepEqual(audit.missingDeliveries.map(issue => issue.orderNo), ['paid-missing']);
  assert.deepEqual(audit.checkedOrders.map(order => order.orderNo), ['paid-missing', 'paid-ok']);
  assert.deepEqual(audit.skippedOrders, [
    {
      orderNo: 'unpaid-skip',
      orderedAt: '2026-04-30T05:00:00.000Z',
      reason: 'no_financial_activity',
    },
  ]);
});

test('buildOrderNotificationAudit reports stale pending Telegram stages for paid orders', () => {
  const audit = buildOrderNotificationAudit([
    {
      order_no: 'paid-stale',
      ordered_at: '2026-04-30T07:40:15.000Z',
      approved_amount: '239000',
      refunded_amount: '0',
      raw: paidOrder('paid-stale', '2026-04-30T07:40:15.000Z', 239000),
    },
  ], {
    getDiagnostics: () => ({
      notificationRecorded: true,
      notification: {
        notificationStage: 'payment_pending',
        messageId: 999,
      },
      importedOrder: null,
    }),
  });

  assert.equal(audit.status, 'failed');
  assert.equal(audit.summary.missingDeliveryCount, 0);
  assert.equal(audit.summary.staleNotificationCount, 1);
  assert.deepEqual(audit.staleNotifications.map(issue => ({
    orderNo: issue.orderNo,
    type: issue.type,
    notificationStage: issue.notificationStage,
    messageId: issue.messageId,
  })), [
    {
      orderNo: 'paid-stale',
      type: 'stale_notification_stage',
      notificationStage: 'payment_pending',
      messageId: 999,
    },
  ]);
});

test('auditRecentOrderNotifications delegates to the ledger reader and preserves skipped database state', async () => {
  const skipped = await auditRecentOrderNotifications({
    orderReader: async () => ({ skipped: true, reason: 'database-url-missing' }),
  });

  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.reason, 'database-url-missing');

  const audit = await auditRecentOrderNotifications({
    lookbackHours: 12,
    limit: 50,
    orderReader: async request => {
      assert.deepEqual(request, {
        sinceTime: undefined,
        lookbackHours: 12,
        limit: 50,
      });
      return {
        ok: true,
        orders: [
          {
            order_no: 'paid-ok',
            ordered_at: '2026-04-30T06:45:17.000Z',
            approved_amount: '158000',
            refunded_amount: '0',
            raw: paidOrder('paid-ok', '2026-04-30T06:45:17.000Z', 158000),
          },
        ],
      };
    },
    getDiagnostics: () => ({
      notificationRecorded: true,
      notification: {
        notificationStage: 'payment_confirmed',
        messageId: 111,
      },
      importedOrder: null,
    }),
  });

  assert.equal(audit.status, 'reconciled');
  assert.equal(audit.summary.checkedOrders, 1);
  assert.equal(audit.issues.length, 0);
});
