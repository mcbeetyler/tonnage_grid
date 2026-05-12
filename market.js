// ─── Market Curve ────────────────────────────────────────────────────────────
// Scatter plot of the physical market: open offers, open bids, and fixtures
// against ETA. Median lines per laycan tag overlay for trend.
//
// Data is reactive — re-renders every time the user switches to the Market
// tab, or clicks Refresh, since bids/offers are manually edited and change
// frequently.

let marketChart = null;
let marketBoxChart = null;

const _origSwitchTabMarket = window.switchTab;
window.switchTab = function(tab) {
  _origSwitchTabMarket(tab);
  if (tab === 'market') {
    populateMarketMonths();
    renderMarketChart();
    renderMarketBoxChart();
  }
};

function populateMarketMonths() {
  const sel = document.getElementById('marketMonth');
  if (!sel || sel.options.length > 0) return;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const now = new Date();
  const curMonth = now.getMonth();
  const curYear = now.getFullYear();

  let html = '<option value="all">Next 60 days</option>';
  for (let i = 0; i < 6; i++) {
    const m = (curMonth + i) % 12;
    const y = curYear + Math.floor((curMonth + i) / 12);
    html += `<option value="${y}-${String(m + 1).padStart(2, '0')}">${months[m]} ${y}</option>`;
  }
  sel.innerHTML = html;
}

function getMarketFilter() {
  const sel = document.getElementById('marketMonth');
  return sel ? sel.value : 'all';
}

function inMarketWindow(etaIso, mode) {
  if (!etaIso) return false;
  const eta = new Date(etaIso);
  if (isNaN(eta.getTime())) return false;
  if (mode === 'all') {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const limit = new Date(today); limit.setDate(limit.getDate() + 60);
    return eta >= today && eta <= limit;
  }
  const [fy, fm] = mode.split('-').map(Number);
  return eta.getFullYear() === fy && (eta.getMonth() + 1) === fm;
}

// Median y-value per laycan bucket; x is the midpoint of the bucket (day 5/15/25)
function medianByBucket(points) {
  const groups = {};
  for (const p of points) {
    const iso = new Date(p.x).toISOString().slice(0, 10);
    const k = laycanBucketKey(iso);
    if (!groups[k]) groups[k] = [];
    groups[k].push(p.y);
  }
  const result = [];
  Object.keys(groups).sort().forEach(k => {
    const ys = groups[k].slice().sort((a, b) => a - b);
    const median = ys[Math.floor(ys.length / 2)];
    const [yStr, mStr, dStr] = k.split('-');
    const startDay = parseInt(dStr, 10);
    const midDay = startDay === 1 ? 5 : startDay === 11 ? 15 : 25;
    const mid = new Date(parseInt(yStr, 10), parseInt(mStr, 10) - 1, midDay).getTime();
    result.push({ x: mid, y: median });
  });
  return result;
}

function renderMarketCharts() {
  renderMarketChart();
  renderMarketBoxChart();
}

function collectMarketPoints() {
  const mode = getMarketFilter();
  const offers = [];
  const bids = [];
  const fixtures = [];
  for (const v of vessels) {
    if (!inMarketWindow(v.eta_ecsa, mode)) continue;
    const x = new Date(v.eta_ecsa).getTime();
    const p6 = getP6Values(v);
    if (v.status === 'OPEN') {
      if (p6.offer != null) offers.push({ x, y: p6.offer, v });
      if (p6.bid != null) bids.push({ x, y: p6.bid, v });
    } else if (v.status === 'FIXED' && v.fixed_price != null) {
      fixtures.push({ x, y: v.fixed_price, v });
    }
  }
  return { offers, bids, fixtures };
}

function renderMarketChart() {
  const canvas = document.getElementById('marketChart');
  if (!canvas) return;
  const { offers, bids, fixtures } = collectMarketPoints();

  const summary = document.getElementById('marketSummary');
  if (summary) {
    summary.textContent = `${offers.length} offers · ${bids.length} bids · ${fixtures.length} fixtures`;
  }

  const offerMedian = medianByBucket(offers);
  const bidMedian = medianByBucket(bids);

  const RED = 'rgba(220, 53, 69, 1)';
  const RED_FILL = 'rgba(220, 53, 69, 0.55)';
  const GREEN = 'rgba(40, 167, 69, 1)';
  const GREEN_FILL = 'rgba(40, 167, 69, 0.55)';
  const BLUE = 'rgba(24, 95, 165, 1)';

  if (marketChart) marketChart.destroy();

  marketChart = new Chart(canvas, {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'Open offers',
          data: offers,
          backgroundColor: RED_FILL,
          borderColor: RED,
          borderWidth: 1,
          pointRadius: 5,
          pointHoverRadius: 7,
          showLine: false,
        },
        {
          label: 'Open bids',
          data: bids,
          backgroundColor: GREEN_FILL,
          borderColor: GREEN,
          borderWidth: 1,
          pointRadius: 5,
          pointHoverRadius: 7,
          showLine: false,
        },
        {
          label: 'Fixtures',
          data: fixtures,
          backgroundColor: BLUE,
          borderColor: BLUE,
          borderWidth: 2,
          pointStyle: 'crossRot',
          pointRadius: 9,
          pointHoverRadius: 11,
          showLine: false,
        },
        {
          label: 'Median offer',
          data: offerMedian,
          borderColor: RED,
          borderDash: [6, 4],
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 0,
          showLine: true,
          fill: false,
          tension: 0.2,
          order: 10,
        },
        {
          label: 'Median bid',
          data: bidMedian,
          borderColor: GREEN,
          borderDash: [6, 4],
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 0,
          showLine: true,
          fill: false,
          tension: 0.2,
          order: 10,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: true },
      plugins: {
        legend: { position: 'top', align: 'end', labels: { boxWidth: 14, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            title: (items) => {
              const d = new Date(items[0].parsed.x);
              return fmtDateReport(d.toISOString().slice(0, 10));
            },
            label: (ctx) => {
              const p = ctx.raw;
              const $val = '$' + ctx.parsed.y.toLocaleString();
              if (!p || !p.v) return `${ctx.dataset.label}: ${$val}`;
              const v = p.v;
              const specs = `${v.dwt ? (v.dwt / 1000).toFixed(0) : '?'}/${v.build_year ? String(v.build_year).slice(2) : '?'}`;
              const lines = [
                `${v.vessel_name} (${specs})`,
                `${ctx.dataset.label}: ${$val}`,
              ];
              if (v.owner) lines.push('Owner: ' + v.owner);
              if (v.charterer) lines.push('Charterer: ' + v.charterer);
              if (v.date_fixed) lines.push('Fixed: ' + fmtDateReport(v.date_fixed));
              return lines;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            callback: (val) => {
              const d = new Date(val);
              return fmtDateReport(d.toISOString().slice(0, 10));
            },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12,
          },
          title: { display: true, text: 'ETA', font: { size: 11 } },
          grid: { color: 'rgba(0,0,0,0.05)' },
        },
        y: {
          ticks: {
            callback: (val) => '$' + val.toLocaleString(),
            font: { size: 11 },
          },
          title: { display: true, text: 'P6 Equivalent ($/day)', font: { size: 11 } },
          grid: { color: 'rgba(0,0,0,0.05)' },
        },
      },
    },
  });
}

// ─── Box & whisker: distribution per laycan tag ──────────────────────────────

function laycanTagLabelFromKey(k) {
  // k is "YYYY-MM-DD" representing the bucket start day
  const [y, m, d] = k.split('-').map(Number);
  const months = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const tier = d === 1 ? '1-10' : d === 11 ? '11-20' : '21+';
  return `${tier} ${months[m]}`;
}

function groupByBucket(points) {
  const groups = {};
  for (const p of points) {
    const iso = new Date(p.x).toISOString().slice(0, 10);
    const k = laycanBucketKey(iso);
    if (!groups[k]) groups[k] = [];
    groups[k].push(p.y);
  }
  return groups;
}

function renderMarketBoxChart() {
  const canvas = document.getElementById('marketBoxChart');
  if (!canvas) return;

  const { offers, bids, fixtures } = collectMarketPoints();

  const offerGroups = groupByBucket(offers);
  const bidGroups = groupByBucket(bids);
  const fixtureGroups = groupByBucket(fixtures);

  // Union of all bucket keys, sorted chronologically
  const allKeys = [...new Set([
    ...Object.keys(offerGroups),
    ...Object.keys(bidGroups),
    ...Object.keys(fixtureGroups),
  ])].sort();

  const labels = allKeys.map(laycanTagLabelFromKey);
  const offerData = allKeys.map(k => offerGroups[k] || []);
  const bidData = allKeys.map(k => bidGroups[k] || []);
  const fixtureData = allKeys.map(k => fixtureGroups[k] || []);

  const RED = 'rgba(220, 53, 69, 1)';
  const RED_FILL = 'rgba(220, 53, 69, 0.25)';
  const GREEN = 'rgba(40, 167, 69, 1)';
  const GREEN_FILL = 'rgba(40, 167, 69, 0.25)';
  const BLUE = 'rgba(24, 95, 165, 1)';
  const BLUE_FILL = 'rgba(24, 95, 165, 0.25)';

  if (marketBoxChart) marketBoxChart.destroy();

  // Plugin registers 'boxplot' as a Chart.js type
  marketBoxChart = new Chart(canvas, {
    type: 'boxplot',
    data: {
      labels,
      datasets: [
        {
          label: 'Offers',
          data: offerData,
          backgroundColor: RED_FILL,
          borderColor: RED,
          borderWidth: 1.5,
          outlierBackgroundColor: RED,
          outlierRadius: 3,
          itemRadius: 2,
          itemBackgroundColor: RED,
        },
        {
          label: 'Bids',
          data: bidData,
          backgroundColor: GREEN_FILL,
          borderColor: GREEN,
          borderWidth: 1.5,
          outlierBackgroundColor: GREEN,
          outlierRadius: 3,
          itemRadius: 2,
          itemBackgroundColor: GREEN,
        },
        {
          label: 'Fixtures',
          data: fixtureData,
          backgroundColor: BLUE_FILL,
          borderColor: BLUE,
          borderWidth: 1.5,
          outlierBackgroundColor: BLUE,
          outlierRadius: 3,
          itemRadius: 2,
          itemBackgroundColor: BLUE,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', align: 'end', labels: { boxWidth: 14, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const stats = ctx.parsed;
              if (!stats) return ctx.dataset.label;
              const fmt = v => v == null ? '—' : '$' + Math.round(v).toLocaleString();
              const n = (ctx.raw && ctx.raw.length) || 0;
              return [
                `${ctx.dataset.label} (${n} sample${n === 1 ? '' : 's'})`,
                `Median: ${fmt(stats.median)}`,
                `Q1 / Q3: ${fmt(stats.q1)} / ${fmt(stats.q3)}`,
                `Min / Max: ${fmt(stats.min)} / ${fmt(stats.max)}`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Laycan Tag', font: { size: 11 } },
          grid: { color: 'rgba(0,0,0,0.05)' },
          ticks: { font: { size: 11 } },
        },
        y: {
          ticks: {
            callback: (val) => '$' + val.toLocaleString(),
            font: { size: 11 },
          },
          title: { display: true, text: 'P6 Equivalent ($/day)', font: { size: 11 } },
          grid: { color: 'rgba(0,0,0,0.05)' },
        },
      },
    },
  });
}
