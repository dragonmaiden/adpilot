const { formatDateInTimeZone } = require('../domain/time');

function asString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeName(value) {
  return asString(value)
    .replace(/\s+/g, '')
    .toLowerCase();
}

function buildCogsOrderBuckets(cogsOrders) {
  return (Array.isArray(cogsOrders) ? cogsOrders : []).map((order, index) => ({
    id: `cogs:${index}`,
    order,
    orderNumber: asString(order?.orderNumber),
    date: asString(order?.date),
    customerName: normalizeName(order?.name),
  }));
}

function getOrderDate(order) {
  if (!order?.wtime) return '';
  return formatDateInTimeZone(order.wtime);
}

function createExactMatchLookup(cogsBuckets) {
  const exact = new Map();

  for (const bucket of cogsBuckets) {
    if (!bucket.orderNumber) continue;
    const matches = exact.get(bucket.orderNumber) || [];
    matches.push(bucket);
    exact.set(bucket.orderNumber, matches);
  }

  return exact;
}

function assignExactMatches(orders, exactCogsByOrderNumber, assignedCogsIds) {
  const matchesByOrderNo = new Map();

  for (const order of Array.isArray(orders) ? orders : []) {
    const orderNo = asString(order?.orderNo);
    if (!orderNo) continue;

    const candidates = exactCogsByOrderNumber.get(orderNo) || [];
    const next = candidates.find(candidate => !assignedCogsIds.has(candidate.id)) || null;
    if (!next) continue;

    assignedCogsIds.add(next.id);
    matchesByOrderNo.set(orderNo, {
      cogsOrder: next.order,
      matchMode: 'exact_order_number',
    });
  }

  return matchesByOrderNo;
}

function groupByCustomerDate(entries, getKeyParts) {
  const groups = new Map();

  for (const entry of entries) {
    const { date, customerName } = getKeyParts(entry);
    if (!date || !customerName) continue;

    const key = `${date}:${customerName}`;
    const bucket = groups.get(key) || [];
    bucket.push(entry);
    groups.set(key, bucket);
  }

  return groups;
}

function assignUniqueCustomerDateMatches(orders, cogsBuckets, matchesByOrderNo, assignedCogsIds) {
  const unmatchedOrders = (Array.isArray(orders) ? orders : []).filter(order => {
    const orderNo = asString(order?.orderNo);
    return orderNo && !matchesByOrderNo.has(orderNo);
  });
  const unmatchedCogs = cogsBuckets.filter(bucket => !assignedCogsIds.has(bucket.id));
  const orderGroups = groupByCustomerDate(unmatchedOrders, order => ({
    date: getOrderDate(order),
    customerName: normalizeName(order?.ordererName || order?.memberName),
  }));
  const cogsGroups = groupByCustomerDate(unmatchedCogs, bucket => ({
    date: bucket.date,
    customerName: bucket.customerName,
  }));

  for (const [key, groupedOrders] of orderGroups.entries()) {
    const groupedCogs = cogsGroups.get(key) || [];
    if (groupedOrders.length !== 1 || groupedCogs.length !== 1) {
      continue;
    }

    const order = groupedOrders[0];
    const cogs = groupedCogs[0];
    const orderNo = asString(order?.orderNo);
    if (!orderNo || assignedCogsIds.has(cogs.id)) continue;

    assignedCogsIds.add(cogs.id);
    matchesByOrderNo.set(orderNo, {
      cogsOrder: cogs.order,
      matchMode: 'date_customer_unique',
    });
  }

  return matchesByOrderNo;
}

function matchOrdersToCogs(orders, cogsOrders) {
  const cogsBuckets = buildCogsOrderBuckets(cogsOrders);
  const exactCogsByOrderNumber = createExactMatchLookup(cogsBuckets);
  const assignedCogsIds = new Set();
  const matchesByOrderNo = assignExactMatches(orders, exactCogsByOrderNumber, assignedCogsIds);

  assignUniqueCustomerDateMatches(orders, cogsBuckets, matchesByOrderNo, assignedCogsIds);

  return {
    matchesByOrderNo,
    unmatchedCogsOrders: cogsBuckets
      .filter(bucket => !assignedCogsIds.has(bucket.id))
      .map(bucket => bucket.order),
  };
}

module.exports = {
  matchOrdersToCogs,
};
