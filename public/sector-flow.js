const numberFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

let chartInstance = null;
let historyChartInstance = null;
let abortController = null;
let historyAbortController = null;
let activeHistoryDate = '';
let historyDateTouched = false;
let autoRefreshTimer = null;
let forceRefreshTimer = null;
let lastAutoRefreshMinuteKey = '';

const AUTO_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const AUTO_REFRESH_START_MINUTES = 9 * 60 + 25;
const AUTO_REFRESH_END_MINUTES = 15 * 60 + 5;
const MIN_REALTIME_FETCH_INTERVAL_MS = 5 * 60 * 1000;
const FORCE_REFRESH_HOUR = 14;
const FORCE_REFRESH_MINUTE = 55;

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

function formatShanghaiDate(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatTimeLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value || '--';
  }

  return date.toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function getShanghaiDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}

function getShanghaiNowMs() {
  const parts = getShanghaiDateParts();
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
}

function getShanghaiMinutesOfDay() {
  const parts = getShanghaiDateParts();
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function getShanghaiMinuteKey() {
  const parts = getShanghaiDateParts();
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function isWithinAutoRefreshWindow() {
  const minutes = getShanghaiMinutesOfDay();
  return minutes >= AUTO_REFRESH_START_MINUTES && minutes <= AUTO_REFRESH_END_MINUTES;
}

function getRefreshWindowText() {
  return '09:25-15:05';
}

function getNextShanghaiForceRefreshDelayMs() {
  const now = getShanghaiNowMs();
  const parts = getShanghaiDateParts();
  let target = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    FORCE_REFRESH_HOUR,
    FORCE_REFRESH_MINUTE,
    0
  );

  if (target <= now) {
    target += 24 * 60 * 60 * 1000;
  }

  return target - now;
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

function buildHistoryOption(payload) {
  const snapshots = payload.snapshots || [];
  const sectors = payload.sectors || [];
  const times = snapshots.map((snapshot) => snapshot.capturedAt);
  const mutedColor = cssVar('--muted') || '#687789';
  const axisColor = 'rgba(104, 119, 137, 0.26)';
  const splitColor = 'rgba(104, 119, 137, 0.14)';
  const palette = [
    '#2563eb',
    '#0d9488',
    '#d97706',
    '#7c3aed',
    '#dc2626',
    '#0891b2',
    '#65a30d',
    '#c2410c',
    '#4f46e5',
    '#be123c'
  ];

  return {
    animation: true,
    backgroundColor: 'transparent',
    color: palette,
    grid: {
      left: 78,
      right: 34,
      top: 78,
      bottom: 72
    },
    legend: {
      type: 'scroll',
      top: 18,
      left: 16,
      right: 16,
      itemWidth: 10,
      itemHeight: 10,
      textStyle: {
        color: mutedColor
      }
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(30, 35, 41, 0.92)',
      borderWidth: 0,
      textStyle: {
        color: '#fdf8f1'
      },
      valueFormatter(value) {
        return formatMoney(value);
      },
      axisPointer: {
        type: 'line'
      }
    },
    dataZoom: [
      {
        type: 'inside',
        throttle: 50
      },
      {
        type: 'slider',
        height: 24,
        bottom: 24,
        borderColor: 'rgba(104, 119, 137, 0.18)',
        fillerColor: 'rgba(37, 99, 235, 0.12)',
        handleStyle: {
          color: '#2563eb'
        },
        textStyle: {
          color: mutedColor
        }
      }
    ],
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: times.map(formatTimeLabel),
      axisLabel: {
        color: mutedColor
      },
      axisLine: { lineStyle: { color: axisColor } },
      axisTick: { show: false }
    },
    yAxis: {
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
    series: sectors.map((sector) => ({
      name: sector.name,
      type: 'line',
      smooth: true,
      symbol: 'circle',
      symbolSize: 5,
      connectNulls: true,
      emphasis: {
        focus: 'series'
      },
      lineStyle: {
        width: 2
      },
      data: snapshots.map((snapshot) => {
        const item = (snapshot.items || []).find((entry) => entry.code === sector.code);
        return item && Number.isFinite(item.mainNetInflow) ? item.mainNetInflow : null;
      })
    }))
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

function renderHistoryChart(payload) {
  const chartDom = getEl('sector-flow-history-chart');
  if (!chartDom || !window.echarts) {
    return;
  }

  if (!historyChartInstance) {
    historyChartInstance = echarts.init(chartDom, null, { renderer: 'canvas' });
    window.addEventListener('resize', resizeChart);
  }

  historyChartInstance.setOption(buildHistoryOption(payload), true);
}

function resizeChart() {
  if (chartInstance) {
    chartInstance.resize();
  }
  if (historyChartInstance) {
    historyChartInstance.resize();
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
  setText('sector-flow-count', payload.total ? `${items.length}/${payload.total}` : String(items.length));
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

function setHistoryLoading(isLoading) {
  const button = getEl('sector-flow-history-apply');
  if (button) {
    button.disabled = isLoading;
    button.textContent = isLoading ? '加载中' : '查看';
  }
}

function setHistoryStatus(text) {
  setText('sector-flow-history-status', text);
}

function getPayloadTradingDate(payload) {
  if (payload.persistence && payload.persistence.tradingDate) {
    return payload.persistence.tradingDate;
  }

  const itemDate = (payload.items || [])
    .map((item) => item.updatedAt)
    .find((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value));

  if (itemDate) {
    return itemDate.slice(0, 10);
  }

  if (payload.updatedAt && /^\d{4}-\d{2}-\d{2}/.test(payload.updatedAt)) {
    return payload.updatedAt.slice(0, 10);
  }

  return formatShanghaiDate();
}

async function loadSectorFlowHistory(date = activeHistoryDate || formatShanghaiDate()) {
  const errorBox = getEl('error');
  if (historyAbortController) {
    historyAbortController.abort();
  }
  historyAbortController = new AbortController();
  activeHistoryDate = date;
  setHistoryLoading(true);
  setHistoryStatus(`${date} 历史快照加载中...`);

  try {
    const payload = await fetchJson(`/api/sector-fund-flow/history?date=${encodeURIComponent(date)}`, {
      signal: historyAbortController.signal
    });

    if (!payload.snapshots || !payload.snapshots.length) {
      if (historyChartInstance) {
        historyChartInstance.clear();
      }
      setHistoryStatus(`${date} 暂无已保存的板块资金快照。`);
      return;
    }

    renderHistoryChart(payload);
    setHistoryStatus(`${date} 已保存 ${payload.totalSnapshots} 次请求快照，覆盖 ${payload.sectorCount} 个板块。`);
  } catch (error) {
    if (error.name === 'AbortError') {
      return;
    }
    setHistoryStatus(`历史数据加载失败：${error.message}`);
    if (errorBox && /Invalid date/.test(error.message)) {
      errorBox.hidden = false;
      errorBox.textContent = `加载失败：${error.message}`;
    }
  } finally {
    setHistoryLoading(false);
  }
}

function buildSavedSectorFlowPayload(historyPayload) {
  const snapshots = historyPayload.snapshots || [];
  const latestSnapshot = snapshots[snapshots.length - 1] || null;
  const items = latestSnapshot
    ? (latestSnapshot.items || []).map((item, index) => ({
      rank: Number.isFinite(item.rank) ? item.rank : index + 1,
      key: item.code,
      code: item.code,
      name: item.name,
      rawName: item.name,
      sourceType: 'saved',
      changePct: Number.isFinite(item.changePct) ? item.changePct : null,
      mainNetInflow: Number.isFinite(item.mainNetInflow) ? item.mainNetInflow : null,
      mainNetInflowPct: Number.isFinite(item.mainNetInflowPct) ? item.mainNetInflowPct : null,
      superNetInflow: null,
      bigNetInflow: null,
      updatedAt: latestSnapshot.capturedAt ? formatTimeLabel(latestSnapshot.capturedAt) : historyPayload.date
    }))
    : [];

  return {
    source: 'Supabase sector flow history',
    sectorType: 'saved',
    sortBy: 'mainNetInflow',
    total: historyPayload.sectorCount || items.length,
    updatedAt: latestSnapshot ? formatTimeLabel(latestSnapshot.capturedAt) : '--',
    items
  };
}

function getLatestHistorySnapshot(historyPayload) {
  const snapshots = historyPayload && Array.isArray(historyPayload.snapshots) ? historyPayload.snapshots : [];
  return snapshots[snapshots.length - 1] || null;
}

function getSnapshotAgeMs(snapshot) {
  if (!snapshot || !snapshot.capturedAt) {
    return Infinity;
  }

  const capturedAtMs = new Date(snapshot.capturedAt).getTime();
  if (!Number.isFinite(capturedAtMs)) {
    return Infinity;
  }

  return Math.max(0, Date.now() - capturedAtMs);
}

function isRecentHistoryPayload(historyPayload) {
  return getSnapshotAgeMs(getLatestHistorySnapshot(historyPayload)) < MIN_REALTIME_FETCH_INTERVAL_MS;
}

function renderSavedSectorFlow(historyPayload, statusText) {
  if (!historyPayload.snapshots || !historyPayload.snapshots.length) {
    throw new Error(`${historyPayload.date} 暂无已保存的板块资金快照。`);
  }

  const payload = buildSavedSectorFlowPayload(historyPayload);
  if (!payload.items.length) {
    throw new Error(`${historyPayload.date} 暂无可展示的板块资金明细。`);
  }

  renderSummary(payload);
  renderChart(payload.items);
  renderTable(payload.items);
  renderHistoryChart(historyPayload);
  setHistoryStatus(statusText || `${historyPayload.date} 已展示最新保存快照，共 ${historyPayload.totalSnapshots} 次请求记录。`);
}

async function loadSavedSectorFlow(date = formatShanghaiDate()) {
  const historyPayload = await fetchJson(`/api/sector-fund-flow/history?date=${encodeURIComponent(date)}`);
  renderSavedSectorFlow(historyPayload);
}

async function loadSectorFlow({ silent = false } = {}) {
  const errorBox = getEl('error');
  const historyDateInput = getEl('sector-flow-history-date');
  const date = historyDateInput && historyDateInput.value ? historyDateInput.value : formatShanghaiDate();
  if (!isWithinAutoRefreshWindow()) {
    if (errorBox && !silent) {
      errorBox.hidden = true;
    }
    setLoading(true);
    setHistoryLoading(true);
    setText('sector-flow-status', `非实时请求时段 ${getRefreshWindowText()}`);
    setHistoryStatus(`当前不在 ${getRefreshWindowText()}，读取今日已保存快照...`);
    try {
      await loadSavedSectorFlow(date);
    } catch (error) {
      if (errorBox && !silent) {
        errorBox.hidden = false;
        errorBox.textContent = `加载失败：${error.message}`;
      }
      setHistoryStatus(`已暂停实时请求；${error.message}`);
    } finally {
      setLoading(false);
      setHistoryLoading(false);
    }
    return;
  }

  try {
    const historyPayload = await fetchJson(`/api/sector-fund-flow/history?date=${encodeURIComponent(date)}`);
    if (isRecentHistoryPayload(historyPayload)) {
      const latestSnapshot = getLatestHistorySnapshot(historyPayload);
      renderSavedSectorFlow(
        historyPayload,
        `${date} 最新快照 ${formatTimeLabel(latestSnapshot.capturedAt)} 距当前不足 5 分钟，已复用保存数据。`
      );
      if (errorBox && !silent) {
        errorBox.hidden = true;
      }
      setLoading(false);
      setHistoryLoading(false);
      return;
    }
  } catch (error) {
    setHistoryStatus(`历史快照预检查失败，继续请求实时数据：${error.message}`);
  }

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

    const tradingDate = getPayloadTradingDate(payload);
    const historyDateInput = getEl('sector-flow-history-date');
    if (historyDateInput && !historyDateTouched) {
      historyDateInput.value = tradingDate;
      activeHistoryDate = tradingDate;
    }
    await loadSectorFlowHistory((historyDateInput && historyDateInput.value) || tradingDate);
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

function runScheduledSectorFlowRefresh() {
  if (!isWithinAutoRefreshWindow()) {
    return;
  }

  const minuteKey = getShanghaiMinuteKey();
  if (minuteKey === lastAutoRefreshMinuteKey) {
    return;
  }

  lastAutoRefreshMinuteKey = minuteKey;
  loadSectorFlow({ silent: true });
}

function scheduleForceRefresh() {
  if (forceRefreshTimer) {
    clearTimeout(forceRefreshTimer);
  }

  forceRefreshTimer = window.setTimeout(() => {
    runScheduledSectorFlowRefresh();
    scheduleForceRefresh();
  }, getNextShanghaiForceRefreshDelayMs());
}

function startAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
  }

  autoRefreshTimer = window.setInterval(() => {
    runScheduledSectorFlowRefresh();
  }, AUTO_REFRESH_INTERVAL_MS);
  scheduleForceRefresh();
}

function destroy() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  if (historyAbortController) {
    historyAbortController.abort();
    historyAbortController = null;
  }
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (forceRefreshTimer) {
    clearTimeout(forceRefreshTimer);
    forceRefreshTimer = null;
  }
  lastAutoRefreshMinuteKey = '';
  window.removeEventListener('resize', resizeChart);
  if (chartInstance) {
    chartInstance.dispose();
    chartInstance = null;
  }
  if (historyChartInstance) {
    historyChartInstance.dispose();
    historyChartInstance = null;
  }
}

async function init() {
  destroy();
  const historyDateInput = getEl('sector-flow-history-date');
  if (historyDateInput) {
    activeHistoryDate = formatShanghaiDate();
    historyDateInput.value = activeHistoryDate;
  }

  const refreshButton = getEl('sector-flow-refresh');
  if (refreshButton) {
    refreshButton.addEventListener('click', () => loadSectorFlow());
  }
  const historyApplyButton = getEl('sector-flow-history-apply');
  if (historyApplyButton) {
    historyApplyButton.addEventListener('click', () => {
      historyDateTouched = true;
      const date = historyDateInput && historyDateInput.value ? historyDateInput.value : formatShanghaiDate();
      loadSectorFlowHistory(date);
    });
  }
  if (historyDateInput) {
    historyDateInput.addEventListener('change', () => {
      historyDateTouched = true;
      loadSectorFlowHistory(historyDateInput.value || formatShanghaiDate());
    });
  }

  await loadSectorFlow();
  startAutoRefresh();
  return destroy;
}

export { destroy, init };
