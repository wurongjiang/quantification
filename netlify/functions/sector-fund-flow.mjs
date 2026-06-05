function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseEastMoneyPayload(raw) {
  const trimmed = raw.trim();
  const jsonText = trimmed.startsWith('jQuery')
    ? trimmed.replace(/^[^(]*\(/, '').replace(/\);?$/, '')
    : trimmed;
  return JSON.parse(jsonText);
}

function parseEastMoneyTime(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  return formatter.format(date).replace(',', '');
}

function normalizeSectorFlowItem(item, index) {
  return {
    rank: index + 1,
    code: item.f12 || '',
    name: item.f14 || '--',
    price: parseNumber(item.f2),
    changePct: parseNumber(item.f3),
    mainNetInflow: parseNumber(item.f62),
    mainNetInflowPct: parseNumber(item.f184),
    superNetInflow: parseNumber(item.f66),
    superNetInflowPct: parseNumber(item.f69),
    bigNetInflow: parseNumber(item.f72),
    bigNetInflowPct: parseNumber(item.f75),
    mediumNetInflow: parseNumber(item.f78),
    mediumNetInflowPct: parseNumber(item.f81),
    smallNetInflow: parseNumber(item.f84),
    smallNetInflowPct: parseNumber(item.f87),
    updatedAt: parseEastMoneyTime(parseNumber(item.f124))
  };
}

export default async () => {
  try {
    const params = new URLSearchParams({
      fid: 'f62',
      po: '1',
      pz: '10',
      pn: '1',
      np: '1',
      fltt: '2',
      invt: '2',
      fs: 'm:90+t:2',
      fields: 'f12,f14,f2,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f124'
    });
    const response = await fetch(`https://push2.eastmoney.com/api/qt/clist/get?${params.toString()}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 Node FearGreed Demo',
        Accept: 'application/json,text/plain,*/*'
      }
    });

    if (!response.ok) {
      return json({ error: `Eastmoney sector fund flow API responded with ${response.status}` }, 502);
    }

    const payload = parseEastMoneyPayload(await response.text());
    const rows = payload && payload.data && Array.isArray(payload.data.diff) ? payload.data.diff : [];

    if (!rows.length) {
      return json({ error: 'Eastmoney sector fund flow API did not return data.' }, 502);
    }

    const items = rows.map(normalizeSectorFlowItem);
    return json({
      source: 'Eastmoney sector fund flow',
      sectorType: 'industry',
      sortBy: 'mainNetInflow',
      updatedAt: items.find((item) => item.updatedAt)?.updatedAt || new Date().toISOString(),
      items
    });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
};
