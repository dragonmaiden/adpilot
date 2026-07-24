/* ============================================
   AdPilot — Profit Dashboard
   Application Logic
   ============================================ */

// ── Page Navigation ──
const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.page');

navItems.forEach(item => {
  item.addEventListener('click', event => {
    event.preventDefault();
    const target = item.dataset.page;

    navItems.forEach(navItem => navItem.classList.remove('active'));
    item.classList.add('active');

    pages.forEach(page => page.classList.remove('active'));
    const targetPage = document.querySelector(`.page[data-page="${target}"]`);
    if (targetPage) targetPage.classList.add('active');

    if (window.AdPilotLive) {
      window.AdPilotLive.handlePageActivated(target);
    }
  });
});

// ── KPI Number Animation ──
function animateKPIs() {
  document.querySelectorAll('.kpi-value[data-target]').forEach(element => {
    const target = parseFloat(element.dataset.target);
    if (!target || target === 0) return;
    const prefix = element.dataset.prefix !== undefined ? element.dataset.prefix : '$';
    const suffix = element.dataset.suffix || '';
    const duration = 1200;
    const start = performance.now();
    const isDecimal = target % 1 !== 0;

    function step(now) {
      const progress = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3);
      const current = target * ease;

      element.textContent = isDecimal
        ? prefix + current.toFixed(2) + suffix
        : prefix + Math.round(current).toLocaleString() + suffix;

      if (progress < 1) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  animateKPIs();
});
