const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function getSupabaseRestUrl(path) {
  return `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/${path.replace(/^\/+/, '')}`;
}

function buildHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function requestSupabase(path, options = {}) {
  if (!isSupabaseConfigured()) {
    const error = new Error('Supabase environment variables are not configured.');
    error.code = 'SUPABASE_NOT_CONFIGURED';
    throw error;
  }

  if (typeof fetch !== 'function') {
    throw new Error('This Node runtime does not support fetch.');
  }

  const response = await fetch(getSupabaseRestUrl(path), {
    ...options,
    headers: buildHeaders(options.headers)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = payload && payload.message ? payload.message : `Supabase request failed with ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

function getShanghaiDate(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeMarketTime(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(value)) {
    return `${value.replace(/\s+/, 'T')}:00+08:00`;
  }

  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(value)) {
    return `${value.replace(/\s+/, 'T')}+08:00`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T00:00:00+08:00`;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function getTradingDate(payload, capturedAt) {
  const itemDate = (payload.items || [])
    .map((item) => item.updatedAt)
    .find((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value));

  if (itemDate) {
    return itemDate.slice(0, 10);
  }

  if (payload.updatedAt && /^\d{4}-\d{2}-\d{2}/.test(payload.updatedAt)) {
    return payload.updatedAt.slice(0, 10);
  }

  return getShanghaiDate(capturedAt);
}

function toNumberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function mapItemToRow(item, snapshot, tradingDate, capturedAt) {
  return {
    snapshot_id: snapshot.id,
    trading_date: tradingDate,
    captured_at: capturedAt,
    sector_key: item.key || null,
    code: item.code || '',
    name: item.name || '',
    raw_name: item.rawName || null,
    source_type: item.sourceType || null,
    rank: Number.isFinite(item.rank) ? item.rank : null,
    price: toNumberOrNull(item.price),
    change_pct: toNumberOrNull(item.changePct),
    main_net_inflow: toNumberOrNull(item.mainNetInflow),
    main_net_inflow_pct: toNumberOrNull(item.mainNetInflowPct),
    super_net_inflow: toNumberOrNull(item.superNetInflow),
    big_net_inflow: toNumberOrNull(item.bigNetInflow),
    medium_net_inflow: toNumberOrNull(item.mediumNetInflow),
    small_net_inflow: toNumberOrNull(item.smallNetInflow),
    item_updated_at: normalizeMarketTime(item.updatedAt)
  };
}

async function persistSectorFlowPayload(payload) {
  if (!isSupabaseConfigured()) {
    return {
      skipped: true,
      reason: 'Supabase environment variables are not configured.'
    };
  }

  const capturedAt = new Date();
  const capturedAtIso = capturedAt.toISOString();
  const tradingDate = getTradingDate(payload, capturedAt);
  const marketUpdatedAt = normalizeMarketTime(payload.updatedAt);
  const snapshotRows = await requestSupabase('sector_flow_snapshots', {
    method: 'POST',
    headers: {
      Prefer: 'return=representation'
    },
    body: JSON.stringify({
      trading_date: tradingDate,
      captured_at: capturedAtIso,
      market_updated_at: marketUpdatedAt,
      source: payload.source || 'Eastmoney sector fund flow',
      sector_type: payload.sectorType || 'mainstream',
      sort_by: payload.sortBy || null,
      total: Number.isFinite(payload.total) ? payload.total : null
    })
  });
  const snapshot = Array.isArray(snapshotRows) ? snapshotRows[0] : snapshotRows;

  if (!snapshot || !snapshot.id) {
    throw new Error('Supabase did not return a sector flow snapshot id.');
  }

  const itemRows = (payload.items || []).map((item) => mapItemToRow(item, snapshot, tradingDate, capturedAtIso));
  if (itemRows.length) {
    await requestSupabase('sector_flow_items', {
      method: 'POST',
      headers: {
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(itemRows)
    });
  }

  return {
    skipped: false,
    snapshotId: snapshot.id,
    tradingDate,
    capturedAt: capturedAtIso,
    itemCount: itemRows.length
  };
}

function assertValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    throw new Error('Invalid date. Use YYYY-MM-DD.');
  }
}

function mapHistoryRow(row) {
  return {
    tradingDate: row.trading_date,
    capturedAt: row.captured_at,
    code: row.code,
    name: row.name,
    rank: row.rank,
    changePct: row.change_pct === null ? null : Number(row.change_pct),
    mainNetInflow: row.main_net_inflow === null ? null : Number(row.main_net_inflow),
    mainNetInflowPct: row.main_net_inflow_pct === null ? null : Number(row.main_net_inflow_pct)
  };
}

function groupHistoryRows(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const item = mapHistoryRow(row);
    if (!groups.has(item.capturedAt)) {
      groups.set(item.capturedAt, {
        capturedAt: item.capturedAt,
        items: []
      });
    }
    groups.get(item.capturedAt).items.push(item);
  });

  return Array.from(groups.values()).map((snapshot) => ({
    ...snapshot,
    items: snapshot.items.sort((left, right) => {
      const leftRank = Number.isFinite(left.rank) ? left.rank : Infinity;
      const rightRank = Number.isFinite(right.rank) ? right.rank : Infinity;
      return leftRank - rightRank || left.name.localeCompare(right.name, 'zh-CN');
    })
  }));
}

async function readSectorFlowHistory(date) {
  assertValidDate(date);

  const params = new URLSearchParams({
    select: 'trading_date,captured_at,code,name,rank,change_pct,main_net_inflow,main_net_inflow_pct',
    trading_date: `eq.${date}`,
    order: 'captured_at.asc,rank.asc'
  });
  const rows = await requestSupabase(`sector_flow_items?${params.toString()}`, {
    method: 'GET'
  });
  const snapshots = groupHistoryRows(Array.isArray(rows) ? rows : []);
  const sectorMap = new Map();
  snapshots.forEach((snapshot) => {
    snapshot.items.forEach((item) => {
      if (!sectorMap.has(item.code)) {
        sectorMap.set(item.code, item.name);
      }
    });
  });

  return {
    source: 'Supabase sector flow history',
    date,
    totalSnapshots: snapshots.length,
    sectorCount: sectorMap.size,
    sectors: Array.from(sectorMap, ([code, name]) => ({ code, name })),
    snapshots
  };
}

module.exports = {
  getShanghaiDate,
  isSupabaseConfigured,
  persistSectorFlowPayload,
  readSectorFlowHistory
};
