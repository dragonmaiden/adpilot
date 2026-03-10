/* ============================================
   AdPilot — Live Data Layer
   Connects dashboard to backend API
   ============================================ */
/* global adMetrics, campaigns */

const API_BASE = window.location.origin + '/api';
let pollInterval = null;
let liveMode = false;

// ── API Helper ──
async function api(path, method = 'GET', body = null) {
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API_BASE}${path}`, opts);
    if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
    return res.json();
  } catch (err) {
    console.warn(`[LIVE] API error on ${path}:`, err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════
// LIVE DATA POLLING
// ═══════════════════════════════════════════════

async function checkBackendAvailable() {
  const health = await api('/health');
  return health && health.status === 'ok';
}

async function fetchOverview() {
  const data = await api('/overview');
  if (!data || !data.ready) return null;
  return data;
}

async function fetchOptimizations(limit = 50) {
  return api(`/optimizations?limit=${limit}`);
}

async function fetchScans() {
  return api('/scans');
}

async function fetchAnalytics() {
  return api('/analytics');
}

async function fetchCampaigns() {
  return api('/campaigns');
}

async function fetchPostmortem() {
  return api('/postmortem');
}

// ── Write operations ──
async function triggerScan() {
  return api('/scan', 'POST');
}

async function updateCampaignStatus(campaignId, status) {
  return api(`/campaigns/${campaignId}/status`, 'POST', { status });
}

async function updateCampaignBudget(campaignId, dailyBudget) {
  return api(`/campaigns/${campaignId}/budget`, 'POST', { dailyBudget });
}

async function executeOptimization(optId) {
  return api(`/optimizations/${optId}/execute`, 'POST');
}

async function updateSettings(settings) {
  return api('/settings', 'PUT', settings);
}

// ═══════════════════════════════════════════════
// UPDATE DASHBOARD WITH LIVE DATA
// ═══════════════════════════════════════════════

function formatKRW(val) {
  if (val >= 1000000) return '₩' + (val / 1000000).toFixed(1) + 'M';
  if (val >= 1000) return '₩' + (val / 1000).toFixed(0) + 'K';
  return '₩' + Math.round(val).toLocaleString();
}

async function updateDashboard() {
  const data = await fetchOverview();
  if (!data) return;

  const k = data.kpis;

  // Update KPI cards that have data-live attributes
  updateKPI('liveRevenue', '₩' + Math.round(k.revenue).toLocaleString());
  updateKPI('liveAdSpend', '$' + k.adSpend.toFixed(0));
  updateKPI('liveROAS', k.roas.toFixed(2) + 'x');
  updateKPI('livePurchases', k.purchases.toString());
  updateKPI('liveCPA', '$' + k.cpa.toFixed(2));
  updateKPI('liveCTR', k.ctr.toFixed(2) + '%');
  updateKPI('liveRefundRate', k.refundRate.toFixed(1) + '%');
  updateKPI('liveNetRevenue', '₩' + Math.round(k.netRevenue).toLocaleString());

  // Update last scan time
  if (data.lastScan) {
    const ago = timeSince(new Date(data.lastScan));
    const el = document.getElementById('lastScan');
    if (el) el.textContent = ago;
  }

  // Update scanning state
  const scanBtn = document.getElementById('runScanBtn');
  if (scanBtn) {
    if (data.isScanning) {
      scanBtn.querySelector('span').textContent = 'Scanning...';
      scanBtn.disabled = true;
    } else {
      scanBtn.querySelector('span').textContent = 'Run Scan Now';
      scanBtn.disabled = false;
    }
  }

  // Pulse the live indicator
  const liveDot = document.getElementById('liveDot');
  if (liveDot) liveDot.classList.add('pulse');
  setTimeout(() => { if (liveDot) liveDot.classList.remove('pulse'); }, 1000);
}

async function updateOptimizationLog() {
  const data = await fetchOptimizations(30);
  if (!data) return;

  const container = document.getElementById('optimizationLog');
  if (!container) return;

  if (data.optimizations.length === 0) {
    container.innerHTML = '<div class="empty-state">No optimizations yet. Waiting for first scan...</div>';
    return;
  }

  container.innerHTML = data.optimizations.map(opt => {
    const iconMap = {
      budget: 'wallet',
      bid: 'gavel',
      creative: 'image',
      status: 'power',
      schedule: 'clock',
      targeting: 'target',
    };
    const priorityClass = {
      critical: 'badge-danger',
      high: 'badge-warning',
      medium: 'badge-info',
      low: '',
    };

    return `
      <div class="optimization-item ${opt.executed ? 'executed' : 'pending'}">
        <div class="opt-icon">
          <i data-lucide="${iconMap[opt.type] || 'zap'}"></i>
        </div>
        <div class="opt-content">
          <div class="opt-header">
            <span class="opt-action">${opt.action}</span>
            <span class="badge ${priorityClass[opt.priority] || ''}">${opt.priority}</span>
            ${opt.executed ? '<span class="badge badge-success">Executed</span>' : `<button class="btn btn-sm btn-primary execute-opt" data-opt-id="${opt.id}">Execute</button>`}
          </div>
          <div class="opt-target">${opt.targetName}</div>
          <div class="opt-reason">${opt.reason}</div>
          <div class="opt-impact">${opt.impact}</div>
          <div class="opt-time">${timeSince(new Date(opt.timestamp))}</div>
        </div>
      </div>
    `;
  }).join('');

  // Re-initialize lucide icons
  if (window.lucide) lucide.createIcons();

  // Attach execute handlers
  container.querySelectorAll('.execute-opt').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const optId = e.target.dataset.optId;
      e.target.textContent = 'Sending approval...';
      e.target.disabled = true;
      const result = await executeOptimization(optId);
      if (result && result.pending) {
        e.target.textContent = '⏳ Check Telegram';
        e.target.title = 'Approval request sent to Telegram.';
      } else if (result && result.success) {
        e.target.textContent = 'Done';
        e.target.classList.remove('btn-primary');
        e.target.classList.add('btn-ghost');
      } else {
        e.target.textContent = 'Failed';
      }
    });
  });

  // Update stats
  const statsEl = document.getElementById('optStats');
  if (statsEl && data.stats) {
    statsEl.innerHTML = `
      <span>Total: ${data.total}</span> ·
      <span>Executed: ${data.stats.executed}</span> ·
      <span>Pending: ${data.stats.pending}</span>
    `;
  }
}

async function updateLiveCampaigns() {
  const [campaignData, postmortem] = await Promise.all([
    fetchCampaigns(),
    fetchPostmortem(),
  ]);

  // ── 1. Campaign overview table (all campaigns) ──
  const body = document.getElementById('campaignBody');
  if (body && campaignData) {
    body.innerHTML = campaignData.campaigns.map(c => {
      const m = c.metrics7d || {};
      const statusClass = c.status === 'ACTIVE' ? 'badge-success' : c.status === 'PAUSED' ? 'badge-warning' : '';
      const budget = c.daily_budget ? `$${(parseInt(c.daily_budget) / 100).toFixed(2)}` : '-';

      return `
        <tr>
          <td style="font-weight:600">${c.name}</td>
          <td><span class="badge ${statusClass}">${c.status}</span></td>
          <td>${budget}/day</td>
          <td>$${(m.spend || 0).toFixed(2)}</td>
          <td>${m.purchases || 0}</td>
          <td>${m.cpa ? '$' + m.cpa.toFixed(2) : '-'}</td>
          <td>${m.ctr ? m.ctr.toFixed(2) + '%' : '-'}</td>
          <td>
            ${c.status === 'ACTIVE'
              ? `<button class="btn btn-sm btn-ghost campaign-action" data-id="${c.id}" data-action="PAUSED">Pause</button>`
              : `<button class="btn btn-sm btn-primary campaign-action" data-id="${c.id}" data-action="ACTIVE">Resume</button>`
            }
          </td>
        </tr>
      `;
    }).join('');

    // Attach campaign action handlers
    body.querySelectorAll('.campaign-action').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.dataset.id;
        const action = e.target.dataset.action;
        e.target.textContent = 'Sending approval...';
        e.target.disabled = true;
        const result = await updateCampaignStatus(id, action);
        if (result && result.pending) {
          e.target.textContent = '\u23f3 Check Telegram';
          e.target.title = 'Approval request sent to Telegram. Please approve or reject there.';
          setTimeout(updateLiveCampaigns, 15000);
          setTimeout(updateLiveCampaigns, 60000);
        } else if (result && result.success) {
          e.target.textContent = action === 'PAUSED' ? 'Paused' : 'Resumed';
          setTimeout(updateLiveCampaigns, 1000);
        } else {
          e.target.textContent = 'Error';
        }
      });
    });
  }

  if (!postmortem) return;

  // ── 2. Active ads section ──
  const activeContainer = document.getElementById('activeAdsContainer');
  const activeCount = document.getElementById('activeCount');
  if (activeContainer) {
    const active = postmortem.active || [];
    if (activeCount) activeCount.textContent = `${active.length} ad${active.length !== 1 ? 's' : ''} running`;

    if (active.length === 0) {
      activeContainer.innerHTML = '<div class="empty-state">No active ads right now</div>';
    } else {
      activeContainer.innerHTML = `
        <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">
          ${active.map(ad => {
            const cpaStr = ad.cpa ? `$${ad.cpa.toFixed(2)}` : 'N/A';
            const cpaColor = ad.cpa && ad.cpa < 15 ? '#4ade80' : ad.cpa && ad.cpa < 25 ? '#facc15' : '#f87171';
            return `
              <div style="background:var(--color-surface-alt);border-radius:12px;padding:16px;border:1px solid var(--color-divider)">
                <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:10px">
                  <div style="font-weight:600;font-size:0.9rem;line-height:1.3">${ad.name}</div>
                  <span class="badge badge-success" style="flex-shrink:0;margin-left:8px">LIVE</span>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.82rem">
                  <div><span style="color:var(--color-text-muted)">Spend</span><br><strong>$${ad.spend.toFixed(2)}</strong></div>
                  <div><span style="color:var(--color-text-muted)">Purchases</span><br><strong>${ad.purchases}</strong></div>
                  <div><span style="color:var(--color-text-muted)">CPA</span><br><strong style="color:${cpaColor}">${cpaStr}</strong></div>
                  <div><span style="color:var(--color-text-muted)">CTR</span><br><strong>${ad.avgCTR.toFixed(2)}%</strong></div>
                  <div><span style="color:var(--color-text-muted)">CPM</span><br><strong>$${ad.avgCPM.toFixed(2)}</strong></div>
                  <div><span style="color:var(--color-text-muted)">Freq</span><br><strong>${ad.lastFrequency.toFixed(1)}</strong></div>
                </div>
                <div style="margin-top:10px;font-size:0.75rem;color:var(--color-text-faint)">${ad.daysOfData} days of data · ${ad.campaignName}</div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }
  }

  // ── 3. Lessons summary ──
  const lessonsSummaryEl = document.getElementById('lessonsSummary');
  if (lessonsSummaryEl) {
    const summary = postmortem.lessonsSummary || {};
    const lessonLabels = {
      no_conversions: { icon: '⚠️', title: 'Zero Conversions', color: '#f87171', tip: 'Test different creatives, audiences, or offers before scaling spend' },
      high_cpa: { icon: '💸', title: 'High CPA', color: '#facc15', tip: 'Narrow targeting or improve ad relevance to lower acquisition cost' },
      ctr_decay: { icon: '📉', title: 'CTR Decay (Fatigue)', color: '#fb923c', tip: 'Rotate creatives every 1–2 weeks to keep engagement fresh' },
      high_frequency: { icon: '🔁', title: 'Audience Saturation', color: '#c084fc', tip: 'Expand lookalike audiences or add new interest groups' },
      clicks_no_purchase: { icon: '🛒', title: 'Clicks but No Sales', color: '#38bdf8', tip: 'Review landing page experience, pricing, and checkout flow' },
      general: { icon: '📝', title: 'Manually Paused', color: '#94a3b8', tip: 'Replaced by better-performing creative variants' },
      no_data: { icon: '💭', title: 'No Recent Data', color: '#64748b', tip: 'Paused before the current analysis window' },
    };

    const keys = Object.keys(summary).filter(k => k !== 'no_data');
    if (keys.length > 0) {
      lessonsSummaryEl.innerHTML = `
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
          ${keys.map(k => {
            const info = lessonLabels[k] || { icon: 'ℹ️', title: k, color: '#94a3b8', tip: '' };
            return `
              <div style="background:${info.color}15;border:1px solid ${info.color}30;border-radius:10px;padding:12px 16px;flex:1;min-width:200px">
                <div style="font-size:1.1rem;margin-bottom:4px">${info.icon} <strong style="color:${info.color}">${summary[k].count}</strong></div>
                <div style="font-weight:600;font-size:0.85rem;margin-bottom:4px">${info.title}</div>
                <div style="font-size:0.78rem;color:var(--color-text-muted);line-height:1.4">${info.tip}</div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    } else {
      lessonsSummaryEl.innerHTML = '';
    }
  }

  // ── 4. Inactive ads with individual lessons ──
  const inactiveContainer = document.getElementById('inactiveAdsContainer');
  const inactiveCount = document.getElementById('inactiveCount');
  if (inactiveContainer) {
    const inactive = postmortem.inactive || [];
    const noData = postmortem.noData || [];
    if (inactiveCount) inactiveCount.textContent = `${inactive.length} with data · ${noData.length} archived`;

    if (inactive.length === 0 && noData.length === 0) {
      inactiveContainer.innerHTML = '<div class="empty-state">No paused ads</div>';
    } else {
      inactiveContainer.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:8px">
          ${inactive.map(ad => {
            const lessonHTML = ad.lessons.map(l => {
              const typeIcons = {
                no_conversions: '⚠️', high_cpa: '💸', ctr_decay: '📉',
                high_frequency: '🔁', clicks_no_purchase: '🛒', general: '📝', no_data: '💭'
              };
              return `<div style="font-size:0.8rem;color:var(--color-text-muted);margin-top:4px">${typeIcons[l.type] || '•'} ${l.text}</div>`;
            }).join('');

            return `
              <div style="background:var(--color-surface-alt);border-radius:10px;padding:14px 16px;border:1px solid var(--color-divider);opacity:0.85">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                  <div style="font-weight:600;font-size:0.88rem">${ad.name}</div>
                  <div style="display:flex;gap:8px;align-items:center;font-size:0.78rem;color:var(--color-text-faint)">
                    <span>$${ad.spend.toFixed(2)} spent</span>
                    <span>·</span>
                    <span>${ad.purchases} purchase${ad.purchases !== 1 ? 's' : ''}</span>
                    <span>·</span>
                    <span>${ad.avgCTR.toFixed(2)}% CTR</span>
                    ${ad.cpa ? `<span>·</span><span>$${ad.cpa.toFixed(2)} CPA</span>` : ''}
                  </div>
                </div>
                ${lessonHTML}
                <div style="font-size:0.72rem;color:var(--color-text-faint);margin-top:6px">${ad.daysOfData} days of data · ${ad.campaignName}</div>
              </div>
            `;
          }).join('')}
          ${noData.length > 0 ? `
            <div style="margin-top:8px;padding:12px 16px;background:var(--color-surface-alt);border-radius:10px;border:1px solid var(--color-divider);opacity:0.6">
              <div style="font-weight:600;font-size:0.85rem;margin-bottom:6px">💭 ${noData.length} Archived Ads (no recent data)</div>
              <div style="font-size:0.78rem;color:var(--color-text-faint);line-height:1.6">
                ${noData.map(a => a.name).join(' · ')}
              </div>
            </div>
          ` : ''}
        </div>
      `;
    }
  }
}

// ═══════════════════════════════════════════════
// LIVE OPTIMIZATION TIMELINE
// ═══════════════════════════════════════════════

async function updateOptTimeline() {
  // Fetch daily spend data from the spend-daily endpoint
  const spendData = await api('/spend-daily');

  // Update candlestick chart with live spend data
  if (typeof optTimelineChart !== 'undefined' && optTimelineChart && spendData && spendData.length > 0) {
    const labels = spendData.map(d => {
      const dt = new Date(d.date);
      return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });
    const ohlcData = spendData.map(d => ({ o: d.o, h: d.h, l: d.l, c: d.c }));

    optTimelineChart.data.labels = labels;
    optTimelineChart.data.datasets[0].data = ohlcData;
    optTimelineChart.data.datasets[1].data = spendData.map(d => d.cac);
    // Target CPA + Budget lines stay constant (datasets 2 & 3)
    optTimelineChart.update();

    // Update stats bar
    if (typeof updateCandlestickStats === 'function') {
      updateCandlestickStats(spendData);
    }
  }

  // Update type + priority donuts from live optimization stats
  const optData = await api('/optimizations?limit=500');
  if (optData && optData.stats) {
    if (typeof optTypeChart !== 'undefined' && optTypeChart) {
      const types = optData.stats.byType || {};
      optTypeChart.data.labels = Object.keys(types).map(t => t.charAt(0).toUpperCase() + t.slice(1));
      optTypeChart.data.datasets[0].data = Object.values(types);
      optTypeChart.update();
    }
    if (typeof optPriorityChart !== 'undefined' && optPriorityChart) {
      const prios = optData.stats.byPriority || {};
      const prioColors = { critical: '#ef4444', high: '#fb923c', medium: '#20808D', low: '#64748b' };
      optPriorityChart.data.labels = Object.keys(prios).map(p => p.charAt(0).toUpperCase() + p.slice(1));
      optPriorityChart.data.datasets[0].data = Object.values(prios);
      optPriorityChart.data.datasets[0].backgroundColor = Object.keys(prios).map(p => prioColors[p] || '#94a3b8');
      optPriorityChart.update();
    }

    // Update KPI cards
    const totalEl = document.getElementById('optTotal');
    const execEl = document.getElementById('optExecuted');
    const pendEl = document.getElementById('optPending');
    const scansEl = document.getElementById('optScans');
    if (totalEl) totalEl.textContent = optData.total || 0;
    if (execEl) execEl.textContent = optData.stats.executed || 0;
    if (pendEl) pendEl.textContent = optData.stats.pending || 0;
    if (scansEl) scansEl.textContent = data.totalScans || 0;
  }
}

// ═══════════════════════════════════════════════
// POLLING & LIFECYCLE
// ═══════════════════════════════════════════════

// ── Static fallback for when backend isn't available ──
function renderStaticCampaignsView() {
  // Use the static data from app.js (window-scoped arrays)
  const activeContainer = document.getElementById('activeAdsContainer');
  const activeCount = document.getElementById('activeCount');
  const inactiveContainer = document.getElementById('inactiveAdsContainer');
  const inactiveCount = document.getElementById('inactiveCount');
  const lessonsSummaryEl = document.getElementById('lessonsSummary');

  // Check if app.js ad data is available
  if (typeof adMetrics === 'undefined' || typeof campaigns === 'undefined') return;

  // Use status field from adMetrics (set from real Meta API data)
  const activeAds = adMetrics.filter(a => a.status === 'active');
  const inactiveAds = adMetrics.filter(a => a.status !== 'active');

  // Render active ads
  if (activeContainer) {
    if (activeCount) activeCount.textContent = `${activeAds.length} ads running`;
    activeContainer.innerHTML = `
      <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">
        ${activeAds.map(ad => {
          const cpa = ad.purchases > 0 ? ad.spend / ad.purchases : null;
          const cpaStr = cpa ? `$${cpa.toFixed(2)}` : 'N/A';
          const cpaColor = cpa && cpa < 15 ? '#4ade80' : cpa && cpa < 25 ? '#facc15' : '#f87171';
          const cpm = ad.impressions > 0 ? (ad.spend / ad.impressions * 1000) : 0;
          return `
            <div style="background:var(--color-surface-alt);border-radius:12px;padding:16px;border:1px solid var(--color-divider)">
              <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:10px">
                <div style="font-weight:600;font-size:0.9rem;line-height:1.3">${ad.name}</div>
                <span class="badge badge-success" style="flex-shrink:0;margin-left:8px">LIVE</span>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.82rem">
                <div><span style="color:var(--color-text-muted)">Spend</span><br><strong>$${ad.spend.toFixed(2)}</strong></div>
                <div><span style="color:var(--color-text-muted)">Purchases</span><br><strong>${ad.purchases}</strong></div>
                <div><span style="color:var(--color-text-muted)">CPA</span><br><strong style="color:${cpaColor}">${cpaStr}</strong></div>
                <div><span style="color:var(--color-text-muted)">CTR</span><br><strong>${ad.ctr.toFixed(2)}%</strong></div>
                <div><span style="color:var(--color-text-muted)">CPM</span><br><strong>$${cpm.toFixed(2)}</strong></div>
                <div><span style="color:var(--color-text-muted)">Freq</span><br><strong>${ad.frequency.toFixed(1)}</strong></div>
              </div>
              <div style="margin-top:10px;font-size:0.75rem;color:var(--color-text-faint)">${ad.campaign}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // Generate lessons for inactive ads
  if (lessonsSummaryEl && inactiveAds.length > 0) {
    let noConversions = 0, highCPA = 0, general = 0;
    inactiveAds.forEach(a => {
      if (a.purchases === 0 && a.spend > 10) noConversions++;
      else if (a.purchases > 0 && (a.spend / a.purchases) > 30) highCPA++;
      else if (a.purchases > 0) general++;
    });

    const cards = [];
    if (general > 0) cards.push(`<div style="background:#94a3b815;border:1px solid #94a3b830;border-radius:10px;padding:12px 16px;flex:1;min-width:200px"><div style="font-size:1.1rem;margin-bottom:4px">📝 <strong style="color:#94a3b8">${general}</strong></div><div style="font-weight:600;font-size:0.85rem;margin-bottom:4px">Replaced by Better Creative</div><div style="font-size:0.78rem;color:var(--color-text-muted);line-height:1.4">Paused after newer variants outperformed</div></div>`);
    if (noConversions > 0) cards.push(`<div style="background:#f8717115;border:1px solid #f8717130;border-radius:10px;padding:12px 16px;flex:1;min-width:200px"><div style="font-size:1.1rem;margin-bottom:4px">⚠️ <strong style="color:#f87171">${noConversions}</strong></div><div style="font-weight:600;font-size:0.85rem;margin-bottom:4px">Zero Conversions</div><div style="font-size:0.78rem;color:var(--color-text-muted);line-height:1.4">Test different creatives, audiences, or offers before scaling spend</div></div>`);
    if (highCPA > 0) cards.push(`<div style="background:#facc1515;border:1px solid #facc1530;border-radius:10px;padding:12px 16px;flex:1;min-width:200px"><div style="font-size:1.1rem;margin-bottom:4px">💸 <strong style="color:#facc15">${highCPA}</strong></div><div style="font-weight:600;font-size:0.85rem;margin-bottom:4px">High CPA</div><div style="font-size:0.78rem;color:var(--color-text-muted);line-height:1.4">Narrow targeting or improve ad relevance</div></div>`);

    if (cards.length > 0) {
      lessonsSummaryEl.innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">${cards.join('')}</div>`;
    }
  }

  // Render inactive ads
  if (inactiveContainer && inactiveAds.length > 0) {
    if (inactiveCount) inactiveCount.textContent = `${inactiveAds.length} with data`;
    inactiveContainer.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:8px">
        ${inactiveAds.map(ad => {
          const cpa = ad.purchases > 0 ? ad.spend / ad.purchases : null;
          const lesson = ad.purchases === 0 && ad.spend > 10
            ? `<div style="font-size:0.8rem;color:var(--color-text-muted);margin-top:4px">⚠️ Spent $${ad.spend.toFixed(2)} with zero purchases — creative or targeting didn't resonate</div>${ad.ctr > 5 ? `<div style="font-size:0.8rem;color:var(--color-text-muted);margin-top:4px">🛒 Good CTR (${ad.ctr.toFixed(2)}%) but no purchases — landing page or pricing may be the issue</div>` : ''}`
            : ad.purchases > 0
            ? `<div style="font-size:0.8rem;color:var(--color-text-muted);margin-top:4px">📝 Spent $${ad.spend.toFixed(2)} with ${ad.purchases} purchases — replaced by better-performing creative</div>`
            : '';

          return `
            <div style="background:var(--color-surface-alt);border-radius:10px;padding:14px 16px;border:1px solid var(--color-divider);opacity:0.85">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                <div style="font-weight:600;font-size:0.88rem">${ad.name}</div>
                <div style="display:flex;gap:8px;align-items:center;font-size:0.78rem;color:var(--color-text-faint)">
                  <span>$${ad.spend.toFixed(2)} spent</span>
                  <span>·</span>
                  <span>${ad.purchases} purchase${ad.purchases !== 1 ? 's' : ''}</span>
                  <span>·</span>
                  <span>${ad.ctr.toFixed(2)}% CTR</span>
                  ${cpa ? `<span>·</span><span>$${cpa.toFixed(2)} CPA</span>` : ''}
                </div>
              </div>
              ${lesson}
              <div style="font-size:0.72rem;color:var(--color-text-faint);margin-top:6px">${ad.campaign}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }
}

async function startLiveMode() {
  const available = await checkBackendAvailable();
  if (!available) {
    console.log('[LIVE] Backend not available, running in static mode');
    liveMode = false;
    // Render static fallback for Live Ads and Lessons sections
    renderStaticCampaignsView();
    return false;
  }

  console.log('[LIVE] Backend connected — enabling live mode');
  liveMode = true;

  // Show live indicator
  showLiveIndicator();

  // Initial fetch
  await updateDashboard();
  await updateOptimizationLog();
  await updateLiveCampaigns();
  await updateOptTimeline();

  // Wire up scan button for live scans
  const scanBtn = document.getElementById('runScanBtn');
  if (scanBtn) {
    // Remove existing listeners by cloning
    const newBtn = scanBtn.cloneNode(true);
    scanBtn.parentNode.replaceChild(newBtn, scanBtn);
    newBtn.addEventListener('click', async () => {
      newBtn.querySelector('span').textContent = 'Scanning...';
      newBtn.disabled = true;
      await triggerScan();
      // Poll for completion
      const checkDone = setInterval(async () => {
        const health = await api('/health');
        if (health && !health.isScanning) {
          clearInterval(checkDone);
          newBtn.querySelector('span').textContent = 'Run Scan Now';
          newBtn.disabled = false;
          document.getElementById('lastScan').textContent = 'just now';
          await updateDashboard();
          await updateOptimizationLog();
          await updateLiveCampaigns();
          await updateOptTimeline();
        }
      }, 3000);
    });
  }

  // Poll every 30 seconds
  pollInterval = setInterval(async () => {
    await updateDashboard();
  }, 30000);

  // Update optimization log and timeline every 60 seconds
  setInterval(async () => {
    await updateOptimizationLog();
    await updateOptTimeline();
  }, 60000);

  return true;
}

function showLiveIndicator() {
  // Add live badge next to "Agent Active"
  const statusLabel = document.querySelector('.status-label');
  if (statusLabel) {
    statusLabel.innerHTML = 'Agent Active <span id="liveDot" style="display:inline-block;width:6px;height:6px;background:#4ade80;border-radius:50%;margin-left:4px;animation:livePulse 2s infinite"></span>';
  }

  // Add CSS animation
  if (!document.getElementById('liveStyles')) {
    const style = document.createElement('style');
    style.id = 'liveStyles';
    style.textContent = `
      @keyframes livePulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }
      .optimization-item { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--color-divider); }
      .optimization-item:last-child { border-bottom: none; }
      .opt-icon { width: 36px; height: 36px; border-radius: 8px; background: var(--color-surface-alt); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .opt-icon i { width: 16px; height: 16px; color: var(--color-primary); }
      .opt-content { flex: 1; min-width: 0; }
      .opt-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
      .opt-action { font-weight: 600; font-size: 0.9rem; }
      .opt-target { font-size: 0.8rem; color: var(--color-text-muted); margin-bottom: 2px; }
      .opt-reason { font-size: 0.8rem; color: var(--color-text-faint); }
      .opt-impact { font-size: 0.8rem; color: var(--color-primary); margin-top: 2px; }
      .opt-time { font-size: 0.75rem; color: var(--color-text-faint); margin-top: 4px; }
      .optimization-item.executed { opacity: 0.7; }
      .btn-sm { padding: 2px 8px; font-size: 0.75rem; }
      .badge-info { background: rgba(32, 128, 141, 0.2); color: #20808D; }
      .badge-danger { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
      .empty-state { padding: 32px; text-align: center; color: var(--color-text-faint); }
      #optStats { font-size: 0.8rem; color: var(--color-text-faint); }
      .live-badge { display: inline-flex; align-items: center; gap: 4px; background: rgba(74, 222, 128, 0.15); color: #4ade80; padding: 2px 8px; border-radius: 999px; font-size: 0.7rem; font-weight: 600; }
    `;
    document.head.appendChild(style);
  }
}

// ── Helpers ──
function updateKPI(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function timeSince(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

// ═══════════════════════════════════════════════
// INIT — Try live mode, fall back to static
// ═══════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  // Attempt live connection after static content loads
  setTimeout(() => startLiveMode(), 1500);
});
