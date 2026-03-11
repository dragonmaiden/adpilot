(function () {
  const live = window.AdPilotLive;
  const { esc } = live.shared;
  const { fetchCampaigns, fetchPostmortem, updateCampaignStatus } = live.api;

  async function refreshCampaignsPage() {
    const [campaignData, postmortem] = await Promise.all([
      fetchCampaigns(),
      fetchPostmortem(),
    ]);

    const body = document.getElementById('campaignBody');
    if (body && campaignData) {
      body.innerHTML = campaignData.campaigns.map(campaign => {
        const metrics = campaign.metrics7d || {};
        const status = campaign.status === 'ACTIVE' || campaign.status === 'PAUSED' ? campaign.status : 'UNKNOWN';
        const statusClass = status === 'ACTIVE' ? 'badge-success' : status === 'PAUSED' ? 'badge-warning' : '';
        const budget = campaign.dailyBudget ? `$${(parseInt(campaign.dailyBudget, 10) / 100).toFixed(2)}` : '-';
        const actionButton = status === 'ACTIVE'
          ? `<button class="btn btn-sm btn-ghost campaign-action" data-id="${esc(campaign.id)}" data-action="PAUSED">Pause</button>`
          : status === 'PAUSED'
          ? `<button class="btn btn-sm btn-primary campaign-action" data-id="${esc(campaign.id)}" data-action="ACTIVE">Resume</button>`
          : '—';

        return `
          <tr>
            <td style="font-weight:600">${esc(campaign.name)}</td>
            <td><span class="badge ${statusClass}">${esc(status)}</span></td>
            <td>${budget}/day</td>
            <td>$${(metrics.spend || 0).toFixed(2)}</td>
            <td>${metrics.metaPurchases || 0}</td>
            <td>${metrics.cpa ? '$' + metrics.cpa.toFixed(2) : '-'}</td>
            <td>${metrics.ctr ? metrics.ctr.toFixed(2) + '%' : '-'}</td>
            <td>${actionButton}</td>
          </tr>
        `;
      }).join('');

      body.querySelectorAll('.campaign-action').forEach(btn => {
        btn.addEventListener('click', async event => {
          const id = event.target.dataset.id;
          const action = event.target.dataset.action;
          event.target.textContent = 'Sending approval...';
          event.target.disabled = true;
          const result = await updateCampaignStatus(id, action);
          if (result && result.pending) {
            event.target.textContent = '⏳ Check Telegram';
            event.target.title = 'Approval request sent to Telegram. Please approve or reject there.';
            setTimeout(() => refreshCampaignsPage(), 15000);
            setTimeout(() => refreshCampaignsPage(), 60000);
          } else if (result && result.success) {
            event.target.textContent = action === 'PAUSED' ? 'Paused' : 'Resumed';
            setTimeout(() => refreshCampaignsPage(), 1000);
          } else {
            event.target.textContent = 'Error';
          }
        });
      });
    }

    if (!postmortem) return;

    const activeContainer = document.getElementById('activeAdsContainer');
    const activeCount = document.getElementById('activeCount');
    if (activeContainer) {
      const active = postmortem.active || [];
      if (activeCount) activeCount.textContent = `${active.length} ad${active.length !== 1 ? 's' : ''} running`;

      if (active.length === 0) {
        activeContainer.innerHTML = '<div class="empty-state">No active ads right now</div>';
      } else {
        activeContainer.innerHTML = `
          <div class="live-ads-grid">
            ${active.map(ad => {
              const cpaStr = ad.cpa ? `$${ad.cpa.toFixed(2)}` : 'N/A';
              const cpaColor = ad.cpa && ad.cpa < 15 ? '#4ade80' : ad.cpa && ad.cpa < 25 ? '#facc15' : '#f87171';
              return `
                <div style="background:var(--color-surface-alt);border-radius:12px;padding:16px;border:1px solid var(--color-divider)">
                  <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:10px">
                    <div style="font-weight:600;font-size:0.9rem;line-height:1.3">${esc(ad.name)}</div>
                    <span class="badge badge-success" style="flex-shrink:0;margin-left:8px">LIVE</span>
                  </div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.82rem">
                    <div><span style="color:var(--color-text-muted)">Spend</span><br><strong>$${ad.spend.toFixed(2)}</strong></div>
                    <div><span style="color:var(--color-text-muted)">Pixel Purchases</span><br><strong>${ad.metaPurchases || 0}</strong></div>
                    <div><span style="color:var(--color-text-muted)">CPA</span><br><strong style="color:${cpaColor}">${cpaStr}</strong></div>
                    <div><span style="color:var(--color-text-muted)">CTR</span><br><strong>${ad.avgCTR.toFixed(2)}%</strong></div>
                    <div><span style="color:var(--color-text-muted)">CPM</span><br><strong>$${ad.avgCPM.toFixed(2)}</strong></div>
                    <div><span style="color:var(--color-text-muted)">Freq</span><br><strong>${ad.lastFrequency.toFixed(1)}</strong></div>
                  </div>
                  <div style="margin-top:10px;font-size:0.75rem;color:var(--color-text-faint)">${ad.daysOfData} days of data · ${esc(ad.campaignName)}</div>
                </div>
              `;
            }).join('')}
          </div>
        `;
      }
    }

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

      const keys = Object.keys(summary).filter(key => key !== 'no_data');
      if (keys.length > 0) {
        lessonsSummaryEl.innerHTML = `
          <div class="lessons-summary-grid">
            ${keys.map(key => {
              const info = lessonLabels[key] || { icon: 'ℹ️', title: key, color: '#94a3b8', tip: '' };
              const count = Number(summary[key].count) || 0;
              return `
                <div style="background:${info.color}15;border:1px solid ${info.color}30;border-radius:10px;padding:12px 16px;flex:1;min-width:200px">
                  <div style="font-size:1.1rem;margin-bottom:4px">${info.icon} <strong style="color:${info.color}">${count}</strong></div>
                  <div style="font-weight:600;font-size:0.85rem;margin-bottom:4px">${esc(info.title)}</div>
                  <div style="font-size:0.78rem;color:var(--color-text-muted);line-height:1.4">${esc(info.tip)}</div>
                </div>
              `;
            }).join('')}
          </div>
        `;
      } else {
        lessonsSummaryEl.innerHTML = '';
      }
    }

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
              const lessonHTML = ad.lessons.map(lesson => {
                const typeIcons = {
                  no_conversions: '⚠️',
                  high_cpa: '💸',
                  ctr_decay: '📉',
                  high_frequency: '🔁',
                  clicks_no_purchase: '🛒',
                  general: '📝',
                  no_data: '💭',
                };
                return `<div style="font-size:0.8rem;color:var(--color-text-muted);margin-top:4px">${typeIcons[lesson.type] || '•'} ${esc(lesson.text)}</div>`;
              }).join('');

              return `
                <div style="background:var(--color-surface-alt);border-radius:10px;padding:14px 16px;border:1px solid var(--color-divider);opacity:0.85">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                    <div style="font-weight:600;font-size:0.88rem">${esc(ad.name)}</div>
                    <div class="inactive-ad-meta">
                      <span>$${ad.spend.toFixed(2)} spent</span>
                      <span>·</span>
                      <span>${ad.metaPurchases || 0} pixel purchase${(ad.metaPurchases || 0) !== 1 ? 's' : ''}</span>
                      <span>·</span>
                      <span>${ad.avgCTR.toFixed(2)}% CTR</span>
                      ${ad.cpa ? `<span>·</span><span>$${ad.cpa.toFixed(2)} CPA</span>` : ''}
                    </div>
                  </div>
                  ${lessonHTML}
                  <div style="font-size:0.72rem;color:var(--color-text-faint);margin-top:6px">${ad.daysOfData} days of data · ${esc(ad.campaignName)}</div>
                </div>
              `;
            }).join('')}
            ${noData.length > 0 ? `
              <div style="margin-top:8px;padding:12px 16px;background:var(--color-surface-alt);border-radius:10px;border:1px solid var(--color-divider);opacity:0.6">
                <div style="font-weight:600;font-size:0.85rem;margin-bottom:6px">💭 ${noData.length} Archived Ads (no recent data)</div>
                <div style="font-size:0.78rem;color:var(--color-text-faint);line-height:1.6">
                  ${noData.map(ad => esc(ad.name)).join(' · ')}
                </div>
              </div>
            ` : ''}
          </div>
        `;
      }
    }
  }

  live.registerPage('campaigns', {
    refresh: refreshCampaignsPage,
  });
})();
