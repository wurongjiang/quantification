const REFRESH_INTERVAL_MS = 60 * 1000;

const numberFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

let chartInstance = null;
let refreshTimer = null;
let abortController = null;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function getEl(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const element = getEl(id);
  if (element) {
    element.textContent = value;
  }
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return '--';
  }
  return numberFormatter.format(value);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return '--';
  }
  return `${formatNumber(value)}%`;
}

function formatMoney(value) {
  if (!Number.isFinite(value)) {
    return '--';
  }

  const absValue = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (absValue >= 100000000) {
    return `${sign}${formatNumber(absValue / 100000000)}亿`;
  }
  if (absValue >= 10000) {
    return `${sign}${formatNumber(absValue / 10000)}万`;
  }
  return `${sign}${formatNumber(absValue)}`;
}

function trendClass(value) {
  if (value > 0) {
    return 'positive';
  }
  if (value < 0) {
    return 'negative';
  }
  return '';
}

function flowColor(value) {
  if (value > 0) {
    return cssVar('--buy') || '#059669';
  }
  if (value < 0) {
    return cssVar('--sell') || '#dc2626';
  }
  return cssVar('--muted') || '#687789';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    const entities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return entities[char];
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return payload;
}

function buildOption(items) {
  const ordered = [...items].reverse();
  const names = ordered.map((item) => item.name);
  const values = ordered.map((item) => item.mainNetInflow || 0);
  const mutedColor = cssVar('--muted') || '#687789';
  const axisColor = 'rgba(104, 119, 137, 0.26)';
  const splitColor = 'rgba(104, 119, 137, 0.14)';

  return {
    animation: true,
    backgroundColor: 'transparent',
    grid: {
      left: 92,
      right: 44,
      top: 28,
      bottom: 34
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'shadow'
      },
      backgroundColor: 'rgba(30, 35, 41, 0.92)',
      borderWidth: 0,
      textStyle: {
        color: '#fdf8f1'
      },
      formatter(params) {
        const item = ordered[params[0].dataIndex];
        return [
          `<div style="margin-bottom:6px;font-weight:600;">${escapeHtml(item.name)}</div>`,
          `主力净流入: ${formatMoney(item.mainNetInflow)}`,
          `主力净占比: ${formatPercent(item.mainNetInflowPct)}`,
          `涨跌幅: ${formatPercent(item.changePct)}`
        ].join('<br>');
      }
    },
    xAxis: {
      type: 'value',
      axisLabel: {
        color: mutedColor,
        formatter(value) {
          return formatMoney(value);
        }
      },
      axisLine: { lineStyle: { color: axisColor } },
      splitLine: {
        lineStyle: { color: splitColor, type: 'dashed' }
      }
    },
    yAxis: {
      type: 'category',
      data: names,
      axisLabel: {
        color: mutedColor,
        overflow: 'truncate',
        width: 78
      },
      axisLine: { lineStyle: { color: axisColor } },
      axisTick: { show: false }
    },
    series: [
      {
        name: '主力净流入',
        type: 'bar',
        data: values,
        barMaxWidth: 24,
        itemStyle: {
          borderRadius: [0, 4, 4, 0],
          color(params) {
            return flowColor(params.value);
          }
        },
        label: {
          show: true,
          position: 'right',
          color: mutedColor,
          formatter(params) {
            return formatMoney(params.value);
          }
        }
      }
    ]
  };
}

function renderChart(items) {
  const chartDom = getEl('sector-flow-chart');
  if (!chartDom || !window.echarts) {
    return;
  }

  if (!chartInstance) {
    chartInstance = echarts.init(chartDom, null, { renderer: 'canvas' });
    window.addEventListener('resize', resizeChart);
  }

  chartInstance.setOption(buildOption(items), true);
}

function resizeChart() {
  if (chartInstance) {
    chartInstance.resize();
  }
}

function renderTable(items) {
  const tableBody = getEl('sector-flow-list');
  const empty = getEl('sector-flow-empty');
  if (!tableBody || !empty) {
    return;
  }

  tableBody.innerHTML = '';
  empty.hidden = items.length > 0;

  items.forEach((item) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="sector-rank">${item.rank}</span></td>
      <td>
        <strong>${escapeHtml(item.name)}</strong>
        <div class="meta">${escapeHtml(item.code)}</div>
      </td>
      <td class="${trendClass(item.changePct)}">${formatPercent(item.changePct)}</td>
      <td class="${trendClass(item.mainNetInflow)}">${formatMoney(item.mainNetInflow)}</td>
      <td class="${trendClass(item.mainNetInflowPct)}">${formatPercent(item.mainNetInflowPct)}</td>
      <td class="${trendClass(item.superNetInflow)}">${formatMoney(item.superNetInflow)}</td>
      <td class="${trendClass(item.bigNetInflow)}">${formatMoney(item.bigNetInflow)}</td>
    `;
    tableBody.appendChild(tr);
  });
}

function renderSummary(payload) {
  const items = payload.items || [];
  const leader = items[0] || null;
  const positiveCount = items.filter((item) => item.mainNetInflow > 0).length;
  const totalInflow = items.reduce((sum, item) => sum + (Number.isFinite(item.mainNetInflow) ? item.mainNetInflow : 0), 0);
  const leaderPercent = leader && Number.isFinite(leader.mainNetInflowPct) ? Math.max(0, Math.min(100, leader.mainNetInflowPct)) : 0;
  const accent = leader ? flowColor(leader.mainNetInflow) : cssVar('--price') || '#2563eb';

  setText('sector-flow-leader', leader ? leader.name : '--');
  setText('sector-flow-leader-money', leader ? formatMoney(leader.mainNetInflow) : '--');
  setText('sector-flow-status', leader ? `主力净占比 ${formatPercent(leader.mainNetInflowPct)}` : '暂无数据');
  setText('sector-flow-updated', payload.updatedAt || '--');
  setText('sector-flow-count', String(items.length));
  setText('sector-flow-positive-count', String(positiveCount));
  setText('sector-flow-total', formatMoney(totalInflow));

  const leaderMoney = getEl('sector-flow-leader-money');
  const status = getEl('sector-flow-status');
  if (leaderMoney) {
    leaderMoney.style.color = accent;
  }
  if (status) {
    status.style.color = accent;
  }
  document.documentElement.style.setProperty('--score-accent', accent);
  document.documentElement.style.setProperty('--score-progress', `${leaderPercent}%`);
}

function setLoading(isLoading) {
  const button = getEl('sector-flow-refresh');
  if (button) {
    button.disabled = isLoading;
    button.textContent = isLoading ? '刷新中' : '刷新';
  }
}

async function loadSectorFlow({ silent = false } = {}) {
  const errorBox = getEl('error');
  if (abortController) {
    abortController.abort();
  }
  abortController = new AbortController();
  setLoading(true);

  if (errorBox && !silent) {
    errorBox.hidden = true;
  }

  try {
    const payload = await fetchJson('/api/sector-fund-flow', {
      signal: abortController.signal
    });
    const items = payload.items || [];

    if (!items.length) {
      throw new Error('没有可展示的板块资金数据。');
    }

    renderSummary(payload);
    renderChart(items);
    renderTable(items);
  } catch (error) {
    if (error.name === 'AbortError') {
      return;
    }
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = `加载失败：${error.message}`;
    }
  } finally {
    setLoading(false);
  }
}

function destroy() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  window.removeEventListener('resize', resizeChart);
  if (chartInstance) {
    chartInstance.dispose();
    chartInstance = null;
  }
}

async function init() {
  destroy();
  const refreshButton = getEl('sector-flow-refresh');
  if (refreshButton) {
    refreshButton.addEventListener('click', () => loadSectorFlow());
  }

  await loadSectorFlow();
  refreshTimer = setInterval(() => loadSectorFlow({ silent: true }), REFRESH_INTERVAL_MS);
  return destroy;
}

export { destroy, init };
