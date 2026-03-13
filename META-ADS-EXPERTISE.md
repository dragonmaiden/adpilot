# META-ADS-EXPERTISE.md

Deep Meta Ads domain expertise, tailored to Shue's business: Korean luxury accessories via Instagram, sold through Imweb, with COGS tracked in Google Sheets.

---

## Shue business profile

**What Shue sells:** Curated luxury accessories — silk scarves, imported leather bags (shoulder bags, hobos, chain bags), premium knitwear (cashmere cardigans, cable knit mufflers), leather goods (card wallets, bracelets), sneakers (calf leather), seasonal items (beanies, shawls). Not mass-market. Not dropshipping. Positioned as curated, quality-verified imports with 3-stage inspection before shipment.

**Brand voice:** "선택이 오래 남는 경험" (A choice that stays with you). Elegant, restrained, emotionally resonant. Not discount-first, even when running sales. Premium without being unapproachable.

**Customer profile:** Primarily women 25-52 in Korea. Fashion-conscious, quality-aware, Instagram-native. Mobile-first shoppers. Responds to aesthetic photography, understated luxury messaging, and time-limited exclusivity. Gift buyers during Korean holidays.

**Pricing tier:** Mid-to-high luxury accessories. AOV high enough that even moderate CPA can be profitable if margin is solid. Lucky box promotions (50-90% off curated sets) serve as entry-point acquisition, not margin drivers.

**Sales channels:** Imweb storefront (primary), Meta Ads (primary acquisition), likely Naver/Kakao organic and direct traffic (invisible to Meta attribution).

**Current account structure:**
- 1 active sales campaign (`260203_판매 테스트`) running lowest-cost bid strategy
- $110/day budget, Instagram + Threads placements
- Female 25-52, Korea, Advantage Audience OFF (manual targeting)
- 4 active ads: silk scarf promos, main creative, imported shoulder bag, Mary Jane shoes
- 3 paused campaigns (traffic test, second sales test, random box campaign)
- 37 total ads across history, most paused — indicates testing velocity

**Current economics (last scan):**
- 7-day spend: $823 (~₩1.2M at current FX)
- 7-day purchases: 55
- 7-day CPA: ~$15 (~₩22k)
- ROAS: 2.76x
- COGS: ₩10.4M across 192 orders, ₩712k shipping
- Net profit margin: ~35% (from optimizer data)
- Imweb currently disconnected (token expired) — revenue/refund data degraded

---

## Meta Ads algorithm — what Shue needs to know

### Learning phase
- Each ad set needs ~50 conversions in 7 days to exit learning
- At Shue's current ~8 purchases/day, the single active ad set clears this threshold — good
- Significant edits (budget >20%, audience change, new creative) reset learning — coordinate changes, don't stack them
- "Learning limited" = ad set can't gather enough signal. With Shue's niche audience, this risk increases if you fragment into too many ad sets

### Why Shue runs lowest-cost (not cost cap)
- Lowest-cost gives Meta maximum flexibility in the auction — good when conversion volume is moderate and you trust the algorithm to find buyers
- Cost cap makes sense when CPA is volatile and you need a ceiling — consider if CPA starts spiking above break-even
- For Shue's volume (~8/day), lowest-cost is correct. Cost cap requires higher volume to learn effectively.

### Advantage Audience (currently OFF on active campaign)
- With Advantage Audience OFF, Meta targets only the 25-52 female Korea segment you specified
- Turning it ON would let Meta expand beyond your targeting — can help scale but risks diluting audience quality
- For luxury accessories, keeping it OFF makes sense: your buyer is specific, and broad expansion may bring clicks from non-buyers
- Revisit only if you hit a frequency ceiling (>2.5 on prospecting) with manual targeting

### Placement reality for Shue
- Running Instagram + Threads. Instagram is doing the heavy lifting — Reels, Stories, Explore, Feed
- Threads is still low-volume but cheap incremental reach
- For luxury visual products, Instagram Reels and Stories are the highest-intent placements
- Explore placement is strong for discovery — new users browsing aesthetically aligned content

---

## Attribution — how to read Shue's numbers honestly

### What Meta reports vs. reality
- Meta defaults to 7-day click, 1-day view attribution
- For a considered luxury purchase, the click-to-buy window may be 2-5 days — 7-day click is reasonable
- View-through (1-day view) inflates numbers: someone sees an ad, then buys organically or via Naver search. Meta takes credit.
- **When Imweb is connected:** Compare Meta-reported purchases to Imweb orders. Expect Meta to over-report by 15-30%.
- **When Imweb is disconnected (current state):** Meta-reported ROAS and purchases are the only signal, but they're optimistic. Reduce confidence on any profit estimate.

### The Naver/Kakao blind spot
- Korean luxury shoppers often see an Instagram ad → search the brand on Naver → buy through Naver Shopping or direct
- This purchase is invisible to Meta but was caused by the ad
- True ROAS is likely higher than Meta reports for direct attribution, but you can't prove it without cross-channel tracking
- Imweb total orders vs. Meta-attributed purchases tells you the gap size

### CAPI and pixel health
- If CAPI is healthy, Meta sees more conversions → optimizes better → lower CPA
- If CAPI degrades, Meta under-counts → worse optimization → CPA rises with no obvious creative or audience cause
- When diagnosing unexplained CPA increases, check source health before blaming creative

---

## Scaling Shue — rules for this specific business

### Current position
- 1 campaign, $110/day, ~8 purchases/day, ~35% net margin, 2.76x ROAS
- This is early-stage scaling. The account is profitable but concentrated.

### Vertical scaling (increase budget on the winning campaign)
- Rule: increase by no more than **20% every 48-72 hours** ($110 → $132 → $158 → $190)
- At each step, wait 48h and check: did CPA hold? Did ROAS hold? Did conversion rate hold?
- If CPA rises >25% after an increase, hold for 72h before trying again
- Target: find the ceiling where CPA starts climbing faster than revenue — that's your current efficient frontier

### When to scale horizontally (new campaigns/ad sets)
- When vertical scaling hits diminishing returns (budget >$200/day and CPA rising)
- Duplicate winning creatives into a new campaign with different audience signal (e.g., lookalike from Imweb purchasers, or broad with Advantage+)
- Do NOT create many small campaigns. Consolidation > fragmentation for the algorithm.

### When NOT to scale
- **Right now with Imweb disconnected** — you can't verify real profit. Scale on incomplete data is gambling.
- When COGS coverage is incomplete for recent orders — you're guessing at margin
- When only 1-2 creatives carry all performance — scale will accelerate fatigue on those creatives. Test new creative first.
- During Korean holiday CPM spikes (추석, Christmas) unless you've proven the economics hold at higher CPM

### Scale readiness checklist for Shue
1. Imweb connected and order data fresh? ☐
2. COGS coverage >80% for last 7 days? ☐
3. Net margin >25% at current CPA? ☐
4. At least 3 active ads performing above break-even? ☐
5. Frequency <2.5 on active ad set? ☐
6. No major holiday CPM spike in next 7 days? ☐

If any box is unchecked, scale cautiously or hold.

---

## Creative strategy for Korean luxury

### What works for Shue's positioning
- **Aesthetic-first static images**: Clean product photography, natural lighting, lifestyle context. Not discount banners.
- **Emotional copy in Korean**: "선택이 오래 남는 경험", "봄을 가장 고급스럽게 두르는 방법" — this is the right register. Aspirational but not pretentious.
- **Bilingual hooks**: "Spring Silk Sale" in English as a visual anchor + Korean body copy works well for the luxury-aspirational demographic
- **Member incentive stacking**: 5% discount + 10,000P for new members is a strong entry offer without cheapening the brand
- **Product-specific storytelling**: wool/cashmere blend details, import verification, 3-stage inspection — justifies the price point

### Fatigue signals specific to Shue
- With only 4 active ads and ~8 purchases/day, creative fatigue arrives faster than high-volume accounts
- **CTR declining over 3+ days** while impressions stable = creative fatigue
- **Frequency >2.0** on a prospecting ad set this size = audience seeing ads too often. Luxury fatigue is worse than mass-market fatigue — repeated luxury ads feel desperate.
- Rotate creative every 2-3 weeks proactively, don't wait for metrics to collapse

### Creative testing framework for Shue
- **Test one variable**: hook image vs. hook image, not hook + copy + format all at once
- **Product category rotation**: Scarves → bags → shoes → accessories. Different products attract different segments.
- **Seasonal angle testing**: Spring styling now, summer accessories next. Plan creative pipeline 2-3 weeks ahead.
- **Kill rule**: If an ad spends 3x target CPA with zero purchases, pause it. For Shue that's ~₩66k (~$45) with no conversion.
- **Graduate rule**: If an ad sustains CPA <₩20k for 5+ days, it's a winner. Protect it by not editing it.

### Lucky box / promotional creative
- Lucky box ads (50-90% off) serve as **acquisition creative**, not margin drivers
- They bring in first-time buyers who may convert to full-price repeat customers
- Track: do lucky box buyers return for full-price purchases? If yes, the true LTV justifies the low-margin acquisition.
- Don't let lucky box ads cannibalize full-price campaigns — run them in separate ad sets or campaigns

---

## Korean market dynamics for luxury e-commerce

### Seasonal CPM calendar affecting Shue
- **January**: Post-holiday dip. Good for testing new creative at low CPM.
- **February**: 설날 (Lunar New Year) gift buying spike mid-month. Scarves, wallets, accessories are strong gift items. CPM rises.
- **March**: Spring collection launches. CPM moderate. Good scaling month.
- **April-May**: 어린이날 (May 5), 어버이날 (May 8) — family gifts. Luxury accessories = strong gift category. CPM spikes.
- **August**: Summer lull for luxury accessories. Lower CPM, but also lower intent.
- **September-October**: 추석 buildup. Gift season again. High CPM but high intent for Shue's category.
- **November**: Korean Black Friday / 11.11. Peak CPM competition. Only participate if your economics hold at 1.5-2x normal CPM.
- **December**: Christmas + year-end gifts. Highest CPM but also highest luxury gift intent.

**Shue's sweet spots**: February (설날 gifts), March-April (spring styling), May (어버이날 gifts), October (추석 gifts), December (Christmas).

### Korean consumer behavior
- **Naver search reflex**: Koreans see an ad → search on Naver before buying. This is normal, not a leak. It means your ads are creating demand even when Meta doesn't get direct attribution.
- **Review culture**: Korean shoppers check reviews obsessively. Imweb review quality and quantity matter for conversion rate — not just the ad.
- **Mobile dominance**: 90%+ of Shue's traffic is likely mobile. Creative must work on small screens. No tiny text, no complex layouts.
- **Point/coupon stacking culture**: Korean shoppers expect membership points, coupons, and welcome offers. Shue's 5% + 10,000P stacking is market-standard and expected, not a differentiator.
- **Refund culture**: Higher refund rates than western markets. Always factor refund pressure into profit math. A 10% refund rate can flip a profitable campaign to break-even.

### FX impact
- Meta bills in USD, Shue earns in KRW
- At ₩1,480/USD (current rate), a $15 CPA = ₩22,200
- If KRW weakens to ₩1,550, the same $15 CPA = ₩23,250 — your real acquisition cost rose 5% with no change in Meta performance
- Monitor FX when analyzing profit trends. A "CPA increase" might actually be a currency move.

---

## Common misdiagnoses to avoid — Shue-specific

1. **"ROAS is 2.76x, we're profitable"** — Only true if margin holds. At 35% margin, 2.76x ROAS is profitable. But if COGS are incomplete (some orders un-costed), real margin may be lower. Always check COGS coverage before celebrating ROAS.

2. **"CPA rose from ₩20k to ₩25k, creative is bad"** — Check frequency first. With only 4 active ads targeting 25-52 Korean women, the audience saturates fast. It might be audience exhaustion, not creative failure.

3. **"We need more campaigns"** — Almost certainly not. More campaigns fragments Meta's learning. Shue's current single-campaign structure is actually correct for this volume. Add creative variety within the campaign, not more campaigns.

4. **"Turn on Advantage Audience to scale"** — Risky for luxury. Advantage Audience expands to people outside your 25-52 female segment. For mass-market products this works. For curated luxury accessories, it often brings cheap clicks from non-buyers.

5. **"Lucky box killed our ROAS"** — Lucky box serves a different purpose (acquisition). Measure it separately. If lucky box buyers convert to full-price later, the true value is LTV-based, not first-order ROAS.

6. **"Imweb is down but Meta numbers look fine"** — This is the most dangerous state. Without Imweb you're flying on Meta's self-reported data, which over-attributes. You literally cannot calculate real profit. Flag this as a priority fix before any scaling decision.

7. **"Spring is coming, time to increase budget"** — Yes, but plan creative first. Seasonal transitions need fresh creative aligned to the new season. Scaling old winter creative into spring is waste.

8. **"The scarf ads work best, run only scarves"** — Product concentration risk. If scarf demand dips or a competitor enters, you have no fallback. Maintain creative diversity across product categories.
