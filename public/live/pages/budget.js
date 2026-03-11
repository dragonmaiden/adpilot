(function () {
  const live = window.AdPilotLive;
  const { esc, timeSince } = live.shared;
  const { fetchCampaigns, fetchAnalytics, fetchOptimizations } = live.api;

  function formatOptimizationScope(level) {
    const labels = {
      account: 'Account',
      campaign: 'Campaign',
      adset: 'Ad Set',
      ad: 'Ad',
    };
    return labels[level] || '—';
  }

  async function refreshBudgetPage() {
    try {
      const [campaignData, analyticsData] = await Promise.all([
        fetchCampaigns(),
        fetchAnalytics(),
      ]);

      if (campaignData && campaignData.campaigns) {
        const campaigns = campaignData.campaigns;
        const active = campaigns.filter(campaign => campaign.status === 'ACTIVE');
        const dailySpendSeries = analyticsData?.charts?.dailyMerged || [];
        const referenceDate = analyticsData?.profitAnalysis?.todaySummary?.date || (dailySpendSeries.length > 0 ? dailySpendSeries[dailySpendSeries.length - 1].date : null);
        const todaySpendRow = dailySpendSeries.find(row => row.date === referenceDate) || (dailySpendSeries.length > 0 ? dailySpendSeries[dailySpendSeries.length - 1] : null);
        const latestDailySpend = todaySpendRow ? (todaySpendRow.spend || 0) : 0;
        const totalDailyBudget = active.reduce((sum, campaign) => {
          return sum + (campaign.dailyBudget ? parseInt(campaign.dailyBudget, 10) / 100 : 0);
        }, 0);

        const dailyBudgetEl = document.querySelector('[data-budget-kpi="daily"] .kpi-value');
        if (dailyBudgetEl) {
          dailyBudgetEl.textContent = totalDailyBudget > 0 ? '$' + totalDailyBudget.toFixed(0) + '/day' : '—';
        }

        const totalSpend = campaigns.reduce((sum, campaign) => {
          const metrics = campaign.metrics7d || {};
          return sum + (metrics.spend || 0);
        }, 0);

        const periodSpendEl = document.querySelector('[data-budget-kpi="periodSpend"] .kpi-value');
        if (periodSpendEl) {
          periodSpendEl.dataset.target = Math.round(totalSpend);
          periodSpendEl.dataset.prefix = '$';
          periodSpendEl.textContent = '$' + Math.round(totalSpend).toLocaleString();
        }

        const remainingEl = document.querySelector('[data-budget-kpi="remaining"] .kpi-value');
        if (remainingEl) {
          if (totalDailyBudget > 0) {
            const remaining = Math.max(0, totalDailyBudget - latestDailySpend);
            remainingEl.textContent = '$' + remaining.toFixed(2) + '/day';
          } else {
            remainingEl.textContent = '—';
          }
        }

        const paceEl = document.querySelector('[data-budget-kpi="pace"] .kpi-value');
        if (paceEl) {
          paceEl.textContent = active.length > 0 ? 'Active' : 'Paused';
          paceEl.className = 'kpi-value ' + (active.length > 0 ? 'pace-on-track' : '');
        }

        const budgetFill = document.querySelector('.budget-fill');
        if (budgetFill && totalDailyBudget > 0) {
          const pct = Math.min(100, (latestDailySpend / totalDailyBudget) * 100);
          budgetFill.style.width = pct + '%';
        }

        if (typeof budgetPieChart !== 'undefined' && budgetPieChart) {
          budgetPieChart.data.labels = campaigns.map(campaign => campaign.name);
          budgetPieChart.data.datasets[0].data = campaigns.map(campaign => {
            const metrics = campaign.metrics7d || {};
            return metrics.spend || 0;
          });
          budgetPieChart.update();
        }
      }

      if (analyticsData && analyticsData.charts?.dailyMerged && typeof budgetPaceChart !== 'undefined' && budgetPaceChart) {
        const spendData = analyticsData.charts.dailyMerged;
        const totalDailyBudget = campaignData
          ? campaignData.campaigns
              .filter(campaign => campaign.status === 'ACTIVE')
              .reduce((sum, campaign) => sum + (campaign.dailyBudget ? parseInt(campaign.dailyBudget, 10) / 100 : 0), 0)
          : 110;

        const daysInPeriod = spendData.length;
        const totalBudget = totalDailyBudget * daysInPeriod;
        const targetLine = spendData.map((_, index) => (totalBudget / daysInPeriod) * (index + 1));

        let cumulative = 0;
        const actualCumulative = spendData.map(row => {
          cumulative += (row.spend || 0);
          return cumulative;
        });

        budgetPaceChart.data.labels = spendData.map(row => row.date);
        budgetPaceChart.data.datasets[0].data = targetLine;
        budgetPaceChart.data.datasets[1].data = actualCumulative;
        budgetPaceChart.update();
      }

      const optData = await fetchOptimizations(20);
      const budgetHistoryEl = document.getElementById('budgetHistory');
      if (budgetHistoryEl && optData && optData.optimizations) {
        const budgetOpts = optData.optimizations.filter(opt => opt.type === 'budget');
        if (budgetOpts.length === 0) {
          budgetHistoryEl.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--color-text-faint);padding:20px">No budget changes yet.</td></tr>';
        } else {
          budgetHistoryEl.innerHTML = budgetOpts.map(opt => `
            <tr>
              <td>${timeSince(new Date(opt.timestamp))}</td>
              <td>${esc(opt.targetName || '—')}</td>
              <td>${esc(formatOptimizationScope(opt.level))}</td>
              <td style="font-weight:600">${esc(opt.action || '—')}</td>
              <td style="color:var(--color-text-muted)">${esc(opt.reason || '—')}</td>
            </tr>
          `).join('');
        }
      }
    } catch (e) {
      console.warn('[LIVE] refreshBudgetPage error:', e.message);
    }
  }

  live.registerPage('budget', {
    refresh: refreshBudgetPage,
  });
})();
