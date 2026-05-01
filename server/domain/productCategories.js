const { getOrderCashTotals } = require('./imwebPayments');

const CATEGORY_RULES = [
  {
    key: 'lucky_box',
    label: 'Lucky Box',
    pattern: /(lucky\s*box|럭키\s*박스|럭키박스)/i,
  },
  {
    key: 'scarves',
    label: 'Scarves',
    pattern: /(스카프|scarf|방도|미차|twilly|트윌리|shawl|숄)/i,
  },
  {
    key: 'bags',
    label: 'Bags',
    pattern: /(bag|백|호보|토트|클러치|쇼퍼|backpack|백팩|베니티|배니티|파우치|pouch|네버풀)/i,
  },
  {
    key: 'shoes',
    label: 'Shoes',
    pattern: /(shoe|shoes|슈즈|스니커즈|sneaker|플랫|발레리나|펌프스|메리제인|mary\s*jane)/i,
  },
  {
    key: 'jewelry',
    label: 'Jewelry',
    pattern: /(jewelry|jewellery|necklace|네크리스|목걸이|펜던트|pendant|earring|이어링|반지|ring|bracelet|브레이슬릿|초커|choker|알함브라)/i,
  },
  {
    key: 'apparel',
    label: 'Apparel',
    pattern: /(shirt|셔츠|가디건|cardigan|자켓|jacket|팬츠|pants|니트|knit|풀오버|후드|hood|집업|패딩|padding|코트|coat|원피스|dress|비니|beanie|롱슬리브|long\s*sleeve)/i,
  },
  {
    key: 'wallets',
    label: 'Wallets',
    pattern: /(wallet|지갑|카드지갑|card\s*holder|cardholder)/i,
  },
  {
    key: 'accessories',
    label: 'Accessories',
    pattern: /(accessor|선글라스|sunglass|안경|glasses|벨트|belt|키링|key\s*ring|키홀더|keyholder)/i,
  },
];
const DEFAULT_CATEGORY_REVENUE_LIMIT = CATEGORY_RULES.length + 1;

function getOrderSections(order) {
  return Array.isArray(order?.sections)
    ? order.sections
    : Array.isArray(order?.orderSections)
      ? order.orderSections
      : [];
}

function getSectionItems(section) {
  return Array.isArray(section?.sectionItems)
    ? section.sectionItems
    : Array.isArray(section?.items)
      ? section.items
      : [];
}

function getProductName(item) {
  return String(item?.productInfo?.prodName || item?.prodName || item?.name || '').trim();
}

function getProductLineRevenue(item) {
  const qty = Math.max(1, Number(item?.qty || item?.quantity || 1));
  const unitPrice = Number(item?.productInfo?.itemPrice ?? item?.itemPrice ?? item?.price ?? 0);
  return Math.max(0, unitPrice * qty);
}

function classifyProductCategory(productName) {
  const name = String(productName || '').trim();
  const match = CATEGORY_RULES.find(rule => rule.pattern.test(name));
  return match
    ? { key: match.key, label: match.label }
    : { key: 'other', label: 'Other' };
}

function pushAggregatedCategory(categories, category, revenue, orderNo, qty = 1) {
  const numericRevenue = Math.max(0, Number(revenue) || 0);
  const existing = categories.get(category.key) || {
    key: category.key,
    label: category.label,
    revenue: 0,
    quantity: 0,
    orderNos: new Set(),
  };
  existing.revenue += numericRevenue;
  existing.quantity += qty;
  if (orderNo) existing.orderNos.add(String(orderNo));
  categories.set(category.key, existing);
}

function collapseProductCategories(rows, limit) {
  const sorted = rows
    .filter(row => Number(row.revenue || 0) > 0)
    .sort((left, right) => Number(right.revenue || 0) - Number(left.revenue || 0));

  if (!Number.isFinite(limit) || limit <= 0 || sorted.length <= limit) {
    return sorted;
  }

  const visible = sorted.slice(0, limit - 1);
  const hidden = sorted.slice(limit - 1);
  const other = hidden.reduce((summary, row) => {
    summary.revenue += Number(row.revenue || 0);
    summary.quantity += Number(row.quantity || 0);
    const orderNos = row.orderNos instanceof Set ? row.orderNos : new Set();
    for (const orderNo of orderNos) {
      summary.orderNos.add(orderNo);
    }
    return summary;
  }, {
    key: 'other',
    label: 'Other',
    revenue: 0,
    quantity: 0,
    orderNos: new Set(),
  });

  return other.revenue > 0 ? [...visible, other] : visible;
}

function buildProductCategoryRevenue(orders, options = {}) {
  const limit = Number(options.limit ?? DEFAULT_CATEGORY_REVENUE_LIMIT);
  const categories = new Map();

  for (const order of Array.isArray(orders) ? orders : []) {
    const { approvedAmount, hasRecognizedCash } = getOrderCashTotals(order);
    if (!hasRecognizedCash || approvedAmount <= 0) continue;

    const items = getOrderSections(order).flatMap(section => getSectionItems(section));
    if (items.length === 0) {
      pushAggregatedCategory(categories, { key: 'other', label: 'Other' }, approvedAmount, order?.orderNo, 1);
      continue;
    }

    const itemRows = items.map(item => ({
      category: classifyProductCategory(getProductName(item)),
      qty: Math.max(1, Number(item?.qty || item?.quantity || 1)),
      listRevenue: getProductLineRevenue(item),
    }));
    const itemTotal = itemRows.reduce((sum, item) => sum + item.listRevenue, 0);
    const fallbackShare = itemRows.length > 0 ? approvedAmount / itemRows.length : 0;

    for (const item of itemRows) {
      const allocatedRevenue = itemTotal > 0
        ? approvedAmount * (item.listRevenue / itemTotal)
        : fallbackShare;
      pushAggregatedCategory(categories, item.category, allocatedRevenue, order?.orderNo, item.qty);
    }
  }

  const collapsed = collapseProductCategories(Array.from(categories.values()), limit);
  const totalRevenue = collapsed.reduce((sum, row) => sum + Number(row.revenue || 0), 0);
  const targetRevenue = Math.round(totalRevenue);
  const roundedRows = collapsed.map(row => ({
    key: row.key,
    label: row.label,
    revenue: Math.round(row.revenue),
    quantity: row.quantity,
    orderCount: row.orderNos instanceof Set ? row.orderNos.size : Number(row.orderCount || 0),
  }));
  const roundedTotal = roundedRows.reduce((sum, row) => sum + Number(row.revenue || 0), 0);
  const roundingDelta = targetRevenue - roundedTotal;
  if (roundingDelta !== 0 && roundedRows.length > 0) {
    roundedRows[0].revenue += roundingDelta;
  }

  return roundedRows.map(row => ({
    ...row,
    share: targetRevenue > 0 ? Number((Number(row.revenue || 0) / targetRevenue).toFixed(4)) : 0,
  }));
}

module.exports = {
  buildProductCategoryRevenue,
  classifyProductCategory,
};
