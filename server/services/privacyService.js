const { getOrderItems } = require('../domain/imwebAttribution');

function asString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function normalizeName(value) {
  return asString(value).replace(/\s+/g, '').toLowerCase();
}

function normalizePhone(value) {
  return asString(value).replace(/\D+/g, '');
}

function normalizeZipcode(value) {
  return asString(value).replace(/\D+/g, '');
}

function normalizeAddress(value) {
  return asString(value)
    .toLowerCase()
    .replace(/[()\[\],.]/g, ' ')
    .replace(/\s+/g, '');
}

function normalizeProductName(value) {
  return asString(value)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\[\]()]/g, '');
}

function buildCombinedAddress(delivery) {
  const parts = [
    asString(delivery?.addr1),
    asString(delivery?.addr2),
  ].filter(Boolean);
  return parts.join(' ').trim();
}

function getOrderSections(order) {
  if (Array.isArray(order?.sections)) return order.sections;
  if (Array.isArray(order?.orderSections)) return order.orderSections;
  return [];
}

function getPrimaryDelivery(order) {
  for (const section of getOrderSections(order)) {
    if (section?.delivery && typeof section.delivery === 'object') {
      return section.delivery;
    }
  }
  return null;
}

function getOrderContactSnapshot(order) {
  const delivery = getPrimaryDelivery(order);
  return {
    ordererName: asString(order?.ordererName || order?.memberName),
    ordererPhone: asString(order?.ordererCall),
    receiverName: asString(delivery?.receiverName),
    receiverPhone: asString(delivery?.receiverCall),
    zipcode: asString(delivery?.zipcode),
    address: buildCombinedAddress(delivery),
  };
}

function getOrderProductNames(order) {
  return unique(
    getOrderItems(order).map(item => (
      asString(item?.productInfo?.prodName || item?.productName || item?.name)
    ))
  );
}

function maskName(value) {
  const text = asString(value);
  if (!text) return '';
  if (text.length === 1) return '*';
  if (text.length === 2) return `${text[0]}*`;
  return `${text[0]}${'*'.repeat(Math.max(1, text.length - 2))}${text[text.length - 1]}`;
}

function maskPhone(value) {
  const digits = normalizePhone(value);
  if (!digits) return '';
  if (digits.length <= 4) return '*'.repeat(digits.length);
  const suffix = digits.slice(-4);
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${suffix}`;
}

function maskOrderNumber(value) {
  const text = asString(value);
  if (!text) return '';
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${'*'.repeat(Math.max(0, text.length - 4))}${text.slice(-4)}`;
}

function maskAddress(value) {
  const text = asString(value);
  if (!text) return '';
  if (text.length <= 10) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 6)}***${text.slice(-4)}`;
}

function sanitizeDelivery(delivery) {
  if (!delivery || typeof delivery !== 'object') return null;

  return {
    receiverName: asString(delivery.receiverName) || null,
    receiverCall: asString(delivery.receiverCall) || null,
    zipcode: asString(delivery.zipcode) || null,
    addr1: asString(delivery.addr1) || null,
    addr2: asString(delivery.addr2) || null,
    building: asString(delivery.building) || null,
    street: asString(delivery.street) || null,
    city: asString(delivery.city) || null,
    state: asString(delivery.state) || null,
    country: asString(delivery.country) || null,
    countryName: asString(delivery.countryName) || null,
    memo: asString(delivery.memo) || null,
  };
}

function sanitizeSectionItem(item) {
  if (!item || typeof item !== 'object') return null;

  return {
    orderSectionItemNo: asString(item.orderSectionItemNo) || null,
    orderItemCode: asString(item.orderItemCode) || null,
    channelOrderItemNo: asString(item.channelOrderItemNo) || null,
    qty: Number(item.qty || 1) || 1,
    gradeDiscount: Number(item.gradeDiscount || 0) || 0,
    itemCouponDiscount: Number(item.itemCouponDiscount || 0) || 0,
    itemPointAmount: Number(item.itemPointAmount || 0) || 0,
    itemPromotionDiscount: Number(item.itemPromotionDiscount || 0) || 0,
    isRestock: asString(item.isRestock) || null,
    isPromotion: asString(item.isPromotion) || null,
    productInfo: item.productInfo && typeof item.productInfo === 'object'
      ? {
          returnableDay: Number(item.productInfo.returnableDay || 0) || 0,
          prodNo: item.productInfo.prodNo ?? null,
          optionDetailCode: asString(item.productInfo.optionDetailCode) || null,
          isIndividualOption: asString(item.productInfo.isIndividualOption) || null,
          prodName: asString(item.productInfo.prodName) || null,
          baseItemPrice: Number(item.productInfo.baseItemPrice || 0) || 0,
          itemPrice: Number(item.productInfo.itemPrice || 0) || 0,
          isTaxFree: asString(item.productInfo.isTaxFree) || null,
          weight: Number(item.productInfo.weight || 0) || 0,
          isRequireOption: asString(item.productInfo.isRequireOption) || null,
          prodSkuNo: item.productInfo.prodSkuNo ?? null,
          optionSkuNo: item.productInfo.optionSkuNo ?? null,
          customProdCode: asString(item.productInfo.customProdCode) || null,
          origin: asString(item.productInfo.origin) || null,
          maker: asString(item.productInfo.maker) || null,
          brand: asString(item.productInfo.brand) || null,
        }
      : null,
  };
}

function sanitizeSection(section) {
  if (!section || typeof section !== 'object') return null;

  return {
    orderSectionNo: asString(section.orderSectionNo) || null,
    orderSectionCode: asString(section.orderSectionCode) || null,
    orderSectionStatus: asString(section.orderSectionStatus || section.orderStatus) || null,
    isDeliveryHold: asString(section.isDeliveryHold) || null,
    deliveryPrice: Number(section.deliveryPrice || 0) || 0,
    deliveryIslandPrice: Number(section.deliveryIslandPrice || 0) || 0,
    deliveryExtraPrice: Number(section.deliveryExtraPrice || 0) || 0,
    deliveryCouponDiscount: Number(section.deliveryCouponDiscount || 0) || 0,
    deliveryPointAmount: Number(section.deliveryPointAmount || 0) || 0,
    deliveryType: asString(section.deliveryType) || null,
    deliveryPayType: asString(section.deliveryPayType) || null,
    deliverySendTime: section.deliverySendTime || null,
    deliveryCompleteTime: section.deliveryCompleteTime || null,
    orderDeliveryCode: asString(section.orderDeliveryCode) || null,
    shippingServiceCode: asString(section.shippingServiceCode) || null,
    pickupMemo: asString(section.pickupMemo) || null,
    sectionItems: (Array.isArray(section.sectionItems) ? section.sectionItems : [])
      .map(sanitizeSectionItem)
      .filter(Boolean),
    delivery: sanitizeDelivery(section.delivery),
  };
}

function sanitizePayment(payment) {
  if (!payment || typeof payment !== 'object') return null;

  const bankTransfer = payment.bankTransfer && typeof payment.bankTransfer === 'object'
    ? {
        depositorName: asString(payment.bankTransfer.depositorName) || null,
        depositCompletedTime: payment.bankTransfer.depositCompletedTime || null,
      }
    : null;

  return {
    paymentNo: payment.paymentNo ?? null,
    method: asString(payment.method) || null,
    pgName: asString(payment.pgName) || null,
    paidPrice: Number(payment.paidPrice || 0) || 0,
    paymentStatus: asString(payment.paymentStatus) || null,
    paymentCompleteTime: payment.paymentCompleteTime || null,
    isCancel: asString(payment.isCancel) || null,
    bankTransfer,
  };
}

function sanitizeImwebOrder(order) {
  if (!order || typeof order !== 'object') return null;

  const sections = getOrderSections(order)
    .map(sanitizeSection)
    .filter(Boolean);

  return {
    orderNo: asString(order.orderNo) || null,
    saleChannel: asString(order.saleChannel) || null,
    isMember: asString(order.isMember) || null,
    isSubscription: asString(order.isSubscription) || null,
    isGift: asString(order.isGift) || null,
    memberCode: asString(order.memberCode) || null,
    memberUid: asString(order.memberUid) || null,
    memberName: asString(order.memberName) || null,
    orderType: asString(order.orderType) || null,
    orderStatus: asString(order.orderStatus) || null,
    currency: asString(order.currency) || null,
    baseItemPrice: Number(order.baseItemPrice || 0) || 0,
    itemPrice: Number(order.itemPrice || 0) || 0,
    gradeDiscount: Number(order.gradeDiscount || 0) || 0,
    itemCouponDiscount: Number(order.itemCouponDiscount || 0) || 0,
    itemPointAmount: Number(order.itemPointAmount || 0) || 0,
    deliveryPrice: Number(order.deliveryPrice || 0) || 0,
    deliveryIslandPrice: Number(order.deliveryIslandPrice || 0) || 0,
    deliveryExtraPrice: Number(order.deliveryExtraPrice || 0) || 0,
    deliveryCouponDiscount: Number(order.deliveryCouponDiscount || 0) || 0,
    deliveryPointAmount: Number(order.deliveryPointAmount || 0) || 0,
    totalPrice: Number(order.totalPrice || 0) || 0,
    totalPaymentPrice: Number(order.totalPaymentPrice || 0) || 0,
    totalDeliveryPrice: Number(order.totalDeliveryPrice || 0) || 0,
    totalDiscountPrice: Number(order.totalDiscountPrice || 0) || 0,
    totalPoint: Number(order.totalPoint || 0) || 0,
    totalRefundedPrice: Number(order.totalRefundedPrice || 0) || 0,
    totalRefundPendingPrice: Number(order.totalRefundPendingPrice || 0) || 0,
    totalRefundedPoint: Number(order.totalRefundedPoint || 0) || 0,
    totalRefundPendingPoint: Number(order.totalRefundPendingPoint || 0) || 0,
    ordererName: asString(order.ordererName) || null,
    ordererCall: asString(order.ordererCall) || null,
    isFirst: asString(order.isFirst) || null,
    isCancelReq: asString(order.isCancelReq) || null,
    unipassNumber: asString(order.unipassNumber) || null,
    isRequestPayment: asString(order.isRequestPayment) || null,
    paymentMethod: asString(order.paymentMethod) || null,
    device: asString(order.device) || null,
    country: asString(order.country) || null,
    wtime: order.wtime || null,
    mtime: order.mtime || null,
    utm: order.utm && typeof order.utm === 'object' ? order.utm : null,
    utmSource: asString(order.utmSource) || null,
    utmMedium: asString(order.utmMedium) || null,
    utmCampaign: asString(order.utmCampaign) || null,
    utmContent: asString(order.utmContent) || null,
    utmTerm: asString(order.utmTerm) || null,
    fbclid: asString(order.fbclid) || null,
    gclid: asString(order.gclid) || null,
    msclkid: asString(order.msclkid) || null,
    referrer: asString(order.referrer || order.referer) || null,
    landingUrl: asString(order.landingUrl || order.landingPage) || null,
    adminUrl: asString(order.adminUrl) || null,
    sections,
    payments: (Array.isArray(order.payments) ? order.payments : [])
      .map(sanitizePayment)
      .filter(Boolean),
  };
}

function sanitizeImwebOrders(orders) {
  return (Array.isArray(orders) ? orders : [])
    .map(sanitizeImwebOrder)
    .filter(Boolean);
}

module.exports = {
  asString,
  normalizeName,
  normalizePhone,
  normalizeZipcode,
  normalizeAddress,
  normalizeProductName,
  buildCombinedAddress,
  getOrderContactSnapshot,
  getOrderProductNames,
  maskName,
  maskPhone,
  maskOrderNumber,
  maskAddress,
  sanitizeImwebOrder,
  sanitizeImwebOrders,
};
