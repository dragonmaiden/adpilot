const { formatDateInTimeZone } = require('../domain/time');
const { getOrderItems } = require('../domain/imwebAttribution');
const {
  buildCombinedAddress,
  normalizeAddress,
  normalizeName,
  normalizePhone,
  normalizeProductName,
  normalizeZipcode,
} = require('./privacyService');

function asString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function getOrderDate(order) {
  if (!order?.wtime) return '';
  return formatDateInTimeZone(order.wtime);
}

function buildCogsOrderBuckets(cogsOrders) {
  return (Array.isArray(cogsOrders) ? cogsOrders : []).map((order, index) => ({
    id: `cogs:${index}`,
    order,
    orderNumber: asString(order?.orderNumber),
    date: asString(order?.date),
    customerName: normalizeName(order?.name),
    receiverName: normalizeName(order?.receiverName),
    ordererPhone: normalizePhone(order?.ordererPhone),
    receiverPhone: normalizePhone(order?.receiverPhone),
    zipcode: normalizeZipcode(order?.zipcode),
    address: normalizeAddress(order?.address),
    productNames: unique((Array.isArray(order?.productNames) ? order.productNames : [order?.productName]).map(normalizeProductName)),
  }));
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

function getOrderSections(order) {
  if (Array.isArray(order?.sections)) return order.sections;
  if (Array.isArray(order?.orderSections)) return order.orderSections;
  return [];
}

function getOrderSignals(order) {
  const delivery = getOrderSections(order)
    .map(section => section?.delivery)
    .find(deliveryEntry => deliveryEntry && typeof deliveryEntry === 'object') || null;

  return {
    orderNo: asString(order?.orderNo),
    date: getOrderDate(order),
    customerName: normalizeName(order?.ordererName || order?.memberName),
    receiverName: normalizeName(delivery?.receiverName),
    phones: unique([
      normalizePhone(order?.ordererCall),
      normalizePhone(delivery?.receiverCall),
    ]),
    zipcode: normalizeZipcode(delivery?.zipcode),
    address: normalizeAddress(buildCombinedAddress(delivery)),
    productNames: unique(
      getOrderItems(order)
        .map(item => normalizeProductName(item?.productInfo?.prodName || item?.productName || item?.name))
    ),
  };
}

function hasNameMatch(orderSignals, cogsSignals) {
  if (orderSignals.customerName && cogsSignals.customerName && orderSignals.customerName === cogsSignals.customerName) {
    return true;
  }

  if (orderSignals.receiverName && cogsSignals.receiverName && orderSignals.receiverName === cogsSignals.receiverName) {
    return true;
  }

  if (orderSignals.customerName && cogsSignals.receiverName && orderSignals.customerName === cogsSignals.receiverName) {
    return true;
  }

  if (orderSignals.receiverName && cogsSignals.customerName && orderSignals.receiverName === cogsSignals.customerName) {
    return true;
  }

  return false;
}

function hasPhoneMatch(orderSignals, cogsSignals) {
  const cogsPhones = [cogsSignals.ordererPhone, cogsSignals.receiverPhone].filter(Boolean);
  return orderSignals.phones.some(phone => phone && cogsPhones.includes(phone));
}

function hasProductOverlap(orderSignals, cogsSignals) {
  if (!orderSignals.productNames.length || !cogsSignals.productNames.length) {
    return false;
  }

  return orderSignals.productNames.some(name => cogsSignals.productNames.includes(name));
}

function assignUniqueSignalMatches(orders, cogsBuckets, matchesByOrderNo, assignedCogsIds, matchMode, predicate) {
  const unmatchedOrders = (Array.isArray(orders) ? orders : []).filter(order => {
    const orderNo = asString(order?.orderNo);
    return orderNo && !matchesByOrderNo.has(orderNo);
  });
  const unmatchedCogs = cogsBuckets.filter(bucket => !assignedCogsIds.has(bucket.id));

  if (unmatchedOrders.length === 0 || unmatchedCogs.length === 0) {
    return matchesByOrderNo;
  }

  const orderCandidates = new Map();
  const cogsCandidates = new Map();

  for (const order of unmatchedOrders) {
    const orderSignals = getOrderSignals(order);
    const candidates = unmatchedCogs.filter(bucket => predicate(orderSignals, bucket));
    orderCandidates.set(orderSignals.orderNo, candidates);

    for (const candidate of candidates) {
      const bucket = cogsCandidates.get(candidate.id) || [];
      bucket.push(orderSignals.orderNo);
      cogsCandidates.set(candidate.id, bucket);
    }
  }

  for (const order of unmatchedOrders) {
    const orderNo = asString(order?.orderNo);
    const candidates = orderCandidates.get(orderNo) || [];
    if (candidates.length !== 1) continue;

    const candidate = candidates[0];
    const candidateOrders = cogsCandidates.get(candidate.id) || [];
    if (candidateOrders.length !== 1) continue;

    assignedCogsIds.add(candidate.id);
    matchesByOrderNo.set(orderNo, {
      cogsOrder: candidate.order,
      matchMode,
    });
  }

  return matchesByOrderNo;
}

function matchOrdersToCogs(orders, cogsOrders) {
  const cogsBuckets = buildCogsOrderBuckets(cogsOrders);
  const exactCogsByOrderNumber = createExactMatchLookup(cogsBuckets);
  const assignedCogsIds = new Set();
  const matchesByOrderNo = assignExactMatches(orders, exactCogsByOrderNumber, assignedCogsIds);

  assignUniqueSignalMatches(orders, cogsBuckets, matchesByOrderNo, assignedCogsIds, 'date_name_phone_unique', (orderSignals, bucket) => (
    Boolean(orderSignals.date)
      && orderSignals.date === bucket.date
      && hasNameMatch(orderSignals, bucket)
      && hasPhoneMatch(orderSignals, bucket)
  ));

  assignUniqueSignalMatches(orders, cogsBuckets, matchesByOrderNo, assignedCogsIds, 'date_name_zipcode_unique', (orderSignals, bucket) => (
    Boolean(orderSignals.date)
      && orderSignals.date === bucket.date
      && hasNameMatch(orderSignals, bucket)
      && Boolean(orderSignals.zipcode)
      && orderSignals.zipcode === bucket.zipcode
  ));

  assignUniqueSignalMatches(orders, cogsBuckets, matchesByOrderNo, assignedCogsIds, 'date_address_unique', (orderSignals, bucket) => (
    Boolean(orderSignals.date)
      && orderSignals.date === bucket.date
      && Boolean(orderSignals.address)
      && orderSignals.address === bucket.address
      && (hasNameMatch(orderSignals, bucket) || hasPhoneMatch(orderSignals, bucket))
  ));

  assignUniqueSignalMatches(orders, cogsBuckets, matchesByOrderNo, assignedCogsIds, 'date_name_product_unique', (orderSignals, bucket) => (
    Boolean(orderSignals.date)
      && orderSignals.date === bucket.date
      && hasNameMatch(orderSignals, bucket)
      && hasProductOverlap(orderSignals, bucket)
  ));

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
