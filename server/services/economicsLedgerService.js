const config = require('../config');
const {
  extractOrderAttribution,
  getOrderItems,
} = require('../domain/imwebAttribution');
const { getOrderCashTotals } = require('../domain/imwebPayments');
const { convertUsdToKrw } = require('../domain/metrics');
const { formatDateInTimeZone } = require('../domain/time');
const { matchOrdersToCogs } = require('./orderCostMatchingService');
const { maskName } = require('./privacyService');

function asString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function roundMoney(value) {
  return Math.round(Number(value || 0));
}

function buildCampaignLookup(campaigns) {
  const lookup = new Map();

  for (const campaign of Array.isArray(campaigns) ? campaigns : []) {
    lookup.set(asString(campaign.id), campaign);
  }

  return lookup;
}

function summarizeOrderProducts(order) {
  const items = getOrderItems(order);
  const productNames = [];

  for (const item of items) {
    const productName = asString(
      item?.productInfo?.prodName || item?.productName
    );
    if (productName && !productNames.includes(productName)) {
      productNames.push(productName);
    }
  }

  return {
    itemCount: items.reduce((sum, item) => sum + Number(item?.qty || 1), 0),
    productSummary: productNames.slice(0, 3).join(', '),
  };
}

function pushMoneyRow(rows, row) {
  rows.push({
    ledgerId: row.ledgerId,
    date: row.date,
    kind: row.kind,
    source: row.source,
    amount: roundMoney(row.amount),
    currency: 'KRW',
    direction: row.direction,
    orderNo: row.orderNo || null,
    campaignId: row.campaignId || null,
    campaignName: row.campaignName || null,
    attributionBucket: row.attributionBucket || null,
    attributionBasis: row.attributionBasis || null,
    attributionConfidence: row.attributionConfidence || null,
    marketingSource: row.marketingSource || null,
    metadata: row.metadata || {},
  });
}

function buildMetaSpendRows(
  campaignInsights,
  campaigns,
  usdToKrwRate = config.currency.usdToKrw
) {
  const campaignLookup = buildCampaignLookup(campaigns);
  const grouped = new Map();

  for (const row of Array.isArray(campaignInsights) ? campaignInsights : []) {
    const campaignId = asString(row?.campaign_id);
    const date = asString(row?.date_start);
    const spendUsd = Number.parseFloat(row?.spend || 0) || 0;
    if (!campaignId || !date || spendUsd <= 0) continue;

    const key = `${campaignId}:${date}`;
    const bucket = grouped.get(key) || {
      date,
      campaignId,
      campaignName:
        asString(row?.campaign_name) ||
        asString(campaignLookup.get(campaignId)?.name) ||
        campaignId,
      spendUsd: 0,
    };
    bucket.spendUsd += spendUsd;
    grouped.set(key, bucket);
  }

  return Array.from(grouped.values())
    .sort((left, right) => {
      if (left.date === right.date)
        return left.campaignId.localeCompare(right.campaignId);
      return left.date.localeCompare(right.date);
    })
    .map((bucket) => ({
      ledgerId: `meta_spend:${bucket.campaignId}:${bucket.date}`,
      date: bucket.date,
      kind: 'meta_spend',
      source: 'meta_ads',
      amount: roundMoney(convertUsdToKrw(bucket.spendUsd, usdToKrwRate)),
      direction: 'debit',
      campaignId: bucket.campaignId,
      campaignName: bucket.campaignName,
      attributionBucket: 'meta',
      attributionBasis: 'ad_platform',
      attributionConfidence: 'high',
      marketingSource: 'meta_ads',
      metadata: {
        spendUsd: Number(bucket.spendUsd.toFixed(2)),
      },
    }));
}

function buildEconomicsLedger({
  orders,
  cogsData,
  campaignInsights,
  campaigns,
  paymentFeeRate = config.fees.paymentFeeRate,
  usdToKrwRate = config.currency.usdToKrw,
}) {
  const rows = [];
  const cogsOrders = Array.isArray(cogsData?.orders) ? cogsData.orders : [];
  const orderCogsMatches = matchOrdersToCogs(orders, cogsOrders);
  const orderSnapshots = [];

  let recognizedOrders = 0;
  let attributedRecognizedOrders = 0;
  let matchedOrdersToCogs = 0;
  let exactMatchedOrdersToCogs = 0;
  let fallbackMatchedOrdersToCogs = 0;
  let totalPaymentFees = 0;
  let unattributedNetRevenue = 0;
  let metaAttributedNetRevenue = 0;
  let nonMetaAttributedNetRevenue = 0;

  for (const order of Array.isArray(orders) ? orders : []) {
    const orderNo = asString(order?.orderNo);
    const orderedAt = order?.wtime || null;
    const date = orderedAt ? formatDateInTimeZone(orderedAt) : null;
    const attribution = extractOrderAttribution(order);
    const cogsMatchEntry =
      orderCogsMatches.matchesByOrderNo.get(orderNo) || null;
    const cogsMatch = cogsMatchEntry?.cogsOrder || null;
    const cogsMatchMode = cogsMatchEntry?.matchMode || 'none';
    const { approvedAmount, netPaidAmount, refundedAmount, hasRecognizedCash } =
      getOrderCashTotals(order);
    const productSummary = summarizeOrderProducts(order);

    if (hasRecognizedCash) {
      recognizedOrders += 1;
      if (attribution.bucket !== 'unattributed') {
        attributedRecognizedOrders += 1;
      }
      if (attribution.bucket === 'meta')
        metaAttributedNetRevenue += netPaidAmount;
      if (attribution.bucket === 'non_meta')
        nonMetaAttributedNetRevenue += netPaidAmount;
      if (attribution.bucket === 'unattributed')
        unattributedNetRevenue += netPaidAmount;
      if (cogsMatch) {
        matchedOrdersToCogs += 1;
        if (cogsMatchMode === 'exact_order_number') {
          exactMatchedOrdersToCogs += 1;
        } else {
          fallbackMatchedOrdersToCogs += 1;
        }
      }
    }

    orderSnapshots.push({
      orderNo: orderNo || null,
      orderedAt,
      date,
      customerName: maskName(order?.ordererName || order?.memberName),
      orderStatus: asString(order?.orderStatus),
      approvedAmount: roundMoney(approvedAmount),
      netPaidAmount: roundMoney(netPaidAmount),
      refundedAmount: roundMoney(refundedAmount),
      recognizedCash: hasRecognizedCash,
      attribution,
      cogsMatched: Boolean(cogsMatch),
      cogsMatchMode,
      cogsCost: roundMoney(cogsMatch?.netCost || 0),
      cogsShipping: roundMoney(cogsMatch?.netShipping || 0),
      costCoverageRatio: Number(cogsMatch?.costCoverageRatio || 0),
      ...productSummary,
    });

    const ledgerDate = date || asString(cogsMatch?.date) || null;
    if (ledgerDate && approvedAmount > 0 && hasRecognizedCash) {
      pushMoneyRow(rows, {
        ledgerId: `imweb_order_approval:${orderNo || 'unknown'}`,
        date: ledgerDate,
        kind: 'order_approval',
        source: 'imweb',
        amount: approvedAmount,
        direction: 'credit',
        orderNo,
        attributionBucket: attribution.bucket,
        attributionBasis: attribution.basis,
        attributionConfidence: attribution.confidence,
        marketingSource: attribution.marketingSource,
        metadata: {
          saleChannel: attribution.saleChannel,
          device: attribution.device,
          country: attribution.country,
        },
      });
    }

    if (ledgerDate && refundedAmount > 0 && hasRecognizedCash) {
      pushMoneyRow(rows, {
        ledgerId: `imweb_order_refund:${orderNo || 'unknown'}`,
        date: ledgerDate,
        kind: 'order_refund',
        source: 'imweb',
        amount: refundedAmount,
        direction: 'debit',
        orderNo,
        attributionBucket: attribution.bucket,
        attributionBasis: attribution.basis,
        attributionConfidence: attribution.confidence,
        marketingSource: attribution.marketingSource,
        metadata: {
          saleChannel: attribution.saleChannel,
        },
      });
    }

    const estimatedFee = netPaidAmount > 0 ? netPaidAmount * paymentFeeRate : 0;
    if (ledgerDate && estimatedFee > 0 && hasRecognizedCash) {
      totalPaymentFees += estimatedFee;
      pushMoneyRow(rows, {
        ledgerId: `imweb_payment_fee:${orderNo || 'unknown'}`,
        date: ledgerDate,
        kind: 'payment_fee',
        source: 'estimate',
        amount: estimatedFee,
        direction: 'debit',
        orderNo,
        attributionBucket: attribution.bucket,
        attributionBasis: attribution.basis,
        attributionConfidence: attribution.confidence,
        marketingSource: attribution.marketingSource,
        metadata: {
          feeRate: paymentFeeRate,
        },
      });
    }

    const cogsSegments =
      cogsMatchEntry?.cogsSegments || (cogsMatch ? [cogsMatch] : []);
    for (const [segmentIndex, segment] of cogsSegments.entries()) {
      const segmentDate = asString(segment.date) || ledgerDate;
      const segmentSuffix =
        cogsSegments.length > 1
          ? `:${asString(segment.orderKey) || `${segmentDate}:${segmentIndex}`}`
          : '';
      if (segmentDate && segment.cost > 0) {
        pushMoneyRow(rows, {
          ledgerId: `cogs_purchase:${orderNo || 'unknown'}${segmentSuffix}`,
          date: segmentDate,
          kind: 'cogs_purchase',
          source: 'cogs_sheet',
          amount: segment.cost,
          direction: 'debit',
          orderNo,
          attributionBucket: attribution.bucket,
          attributionBasis: attribution.basis,
          attributionConfidence: attribution.confidence,
          marketingSource: attribution.marketingSource,
          metadata: {
            matchMode: cogsMatchMode,
            costCoverageRatio: Number(segment.costCoverageRatio || 0),
          },
        });
      }

      if (segmentDate && segment.shipping > 0) {
        pushMoneyRow(rows, {
          ledgerId: `shipping_purchase:${orderNo || 'unknown'}${segmentSuffix}`,
          date: segmentDate,
          kind: 'shipping_purchase',
          source: 'cogs_sheet',
          amount: segment.shipping,
          direction: 'debit',
          orderNo,
          attributionBucket: attribution.bucket,
          attributionBasis: attribution.basis,
          attributionConfidence: attribution.confidence,
          marketingSource: attribution.marketingSource,
          metadata: {
            matchMode: cogsMatchMode,
            costCoverageRatio: Number(segment.costCoverageRatio || 0),
          },
        });
      }

      if (segmentDate && segment.refundCost > 0) {
        pushMoneyRow(rows, {
          ledgerId: `cogs_refund:${orderNo || 'unknown'}${segmentSuffix}`,
          date: segmentDate,
          kind: 'cogs_refund',
          source: 'cogs_sheet',
          amount: segment.refundCost,
          direction: 'credit',
          orderNo,
          attributionBucket: attribution.bucket,
          attributionBasis: attribution.basis,
          attributionConfidence: attribution.confidence,
          marketingSource: attribution.marketingSource,
          metadata: {
            matchMode: cogsMatchMode,
          },
        });
      }

      if (segmentDate && segment.refundShipping > 0) {
        pushMoneyRow(rows, {
          ledgerId: `shipping_refund:${orderNo || 'unknown'}${segmentSuffix}`,
          date: segmentDate,
          kind: 'shipping_refund',
          source: 'cogs_sheet',
          amount: segment.refundShipping,
          direction: 'credit',
          orderNo,
          attributionBucket: attribution.bucket,
          attributionBasis: attribution.basis,
          attributionConfidence: attribution.confidence,
          marketingSource: attribution.marketingSource,
          metadata: {
            matchMode: cogsMatchMode,
          },
        });
      }
    }
  }

  const unmatchedCogsOrders = orderCogsMatches.unmatchedCogsOrders;

  for (const [index, cogsOrder] of unmatchedCogsOrders.entries()) {
    const orderNo = asString(cogsOrder?.orderNumber);
    const date = asString(cogsOrder?.date);
    const sourceKey = asString(cogsOrder?.orderKey) || `${orderNo || cogsOrder.sequenceNo || 'unknown'}:${date || 'undated'}:${index}`;

    if (cogsOrder?.cost > 0) {
      pushMoneyRow(rows, {
        ledgerId: `cogs_purchase_unmatched:${sourceKey}`,
        date,
        kind: 'cogs_purchase',
        source: 'cogs_sheet',
        amount: cogsOrder.cost,
        direction: 'debit',
        orderNo,
        attributionBucket: 'unattributed',
        attributionBasis: 'none',
        attributionConfidence: 'none',
        marketingSource: null,
        metadata: {
          matchMode: 'unmatched',
          customerName: asString(cogsOrder?.name),
        },
      });
    }

    if (cogsOrder?.shipping > 0) {
      pushMoneyRow(rows, {
        ledgerId: `shipping_purchase_unmatched:${sourceKey}`,
        date,
        kind: 'shipping_purchase',
        source: 'cogs_sheet',
        amount: cogsOrder.shipping,
        direction: 'debit',
        orderNo,
        attributionBucket: 'unattributed',
        attributionBasis: 'none',
        attributionConfidence: 'none',
        marketingSource: null,
        metadata: {
          matchMode: 'unmatched',
          customerName: asString(cogsOrder?.name),
        },
      });
    }
    if (cogsOrder?.refundCost > 0) {
      pushMoneyRow(rows, {
        ledgerId: `cogs_refund_unmatched:${sourceKey}`,
        date,
        kind: 'cogs_refund',
        source: 'cogs_sheet',
        amount: cogsOrder.refundCost,
        direction: 'credit',
        orderNo,
        attributionBucket: 'unattributed',
        attributionBasis: 'none',
        attributionConfidence: 'none',
        marketingSource: null,
        metadata: { matchMode: 'unmatched' },
      });
    }
    if (cogsOrder?.refundShipping > 0) {
      pushMoneyRow(rows, {
        ledgerId: `shipping_refund_unmatched:${sourceKey}`,
        date,
        kind: 'shipping_refund',
        source: 'cogs_sheet',
        amount: cogsOrder.refundShipping,
        direction: 'credit',
        orderNo,
        attributionBucket: 'unattributed',
        attributionBasis: 'none',
        attributionConfidence: 'none',
        marketingSource: null,
        metadata: { matchMode: 'unmatched' },
      });
    }
  }

  const metaSpendRows = buildMetaSpendRows(
    campaignInsights,
    campaigns,
    usdToKrwRate
  );
  rows.push(...metaSpendRows);
  rows.sort((left, right) => {
    if (left.date === right.date)
      return String(left.ledgerId).localeCompare(String(right.ledgerId));
    return String(left.date).localeCompare(String(right.date));
  });

  const totalMetaSpendKrw = metaSpendRows.reduce(
    (sum, row) => sum + Number(row.amount || 0),
    0
  );

  return {
    generatedAt: new Date().toISOString(),
    rows,
    orderSnapshots,
    summary: {
      totalRows: rows.length,
      recognizedOrders,
      matchedOrdersToCogs,
      exactMatchedOrdersToCogs,
      fallbackMatchedOrdersToCogs,
      unmatchedOrdersToCogs: Math.max(
        recognizedOrders - matchedOrdersToCogs,
        0
      ),
      unmatchedCogsOrders: unmatchedCogsOrders.length,
      metaSpendRows: metaSpendRows.length,
      totalMetaSpendKrw: roundMoney(totalMetaSpendKrw),
      totalPaymentFees: roundMoney(totalPaymentFees),
      unattributedNetRevenue: roundMoney(unattributedNetRevenue),
      metaAttributedNetRevenue: roundMoney(metaAttributedNetRevenue),
      nonMetaAttributedNetRevenue: roundMoney(nonMetaAttributedNetRevenue),
      cogsMatchRate:
        recognizedOrders > 0 ? matchedOrdersToCogs / recognizedOrders : 0,
      attributionCoverageRate:
        recognizedOrders > 0
          ? attributedRecognizedOrders / recognizedOrders
          : 0,
    },
  };
}

module.exports = {
  buildEconomicsLedger,
};
