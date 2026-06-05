const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const {
  buildSummaryFileName,
  buildSummaryPublicPath,
  extractReviewDate,
  extractReviewLabel,
  extractReviewTitle,
  sortReviewFileNames
} = require('./lib/dailyReviewMeta');

const PORT = process.env.PORT || 4009;
const PUBLIC_DIR = path.join(__dirname, 'public');
const LIB_DIR = path.join(__dirname, 'lib');
const DAILY_REVIEWS_DIR = path.join(__dirname, 'daily-reviews');
const DAILY_REVIEW_SUMMARIES_DIR = path.join(PUBLIC_DIR, 'daily-review-summaries');
const INDEXES = {
  sh000001: '上证指数',
  sh000300: '沪深300',
  sh000905: '中证500',
  sh000688: '科创50',
  sh000852: '中证1000',
  sh510880: '红利ETF',
  sh513120: '创新药ETF',
  sh513160: '港股科技ETF',
  sh518880: '黄金ETF',
  sz159941: '纳指ETF'
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readReviewFile(fileName) {
  if (!fileName || path.basename(fileName) !== fileName || path.extname(fileName).toLowerCase() !== '.md') {
    return Promise.reject(new Error('Invalid review file name.'));
  }

  const filePath = path.join(DAILY_REVIEWS_DIR, fileName);
  const relative = path.relative(DAILY_REVIEWS_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return Promise.reject(new Error('Forbidden review file path.'));
  }

  return fs.promises.readFile(filePath, 'utf8');
}

async function summaryExistsForReview(fileName) {
  const summaryFileName = buildSummaryFileName(fileName);
  if (!summaryFileName) {
    return false;
  }

  const summaryPath = path.join(DAILY_REVIEW_SUMMARIES_DIR, summaryFileName);
  try {
    await fs.promises.access(summaryPath);
    return true;
  } catch {
    return false;
  }
}

async function attachSummaryMeta(review) {
  const hasSummary = await summaryExistsForReview(review.fileName);
  return {
    ...review,
    hasSummary,
    summaryUrl: hasSummary ? buildSummaryPublicPath(review.fileName) : null
  };
}

async function listDailyReviews() {
  const files = await fs.promises.readdir(DAILY_REVIEWS_DIR, { withFileTypes: true });
  const reviewFiles = sortReviewFileNames(
    files
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
  );

  const reviews = await Promise.all(reviewFiles.map(async (fileName) => {
    const content = await readReviewFile(fileName);
    const date = extractReviewDate(fileName);
    return {
      id: fileName,
      fileName,
      date,
      label: extractReviewLabel(fileName),
      title: extractReviewTitle(content, fileName)
    };
  }));

  return Promise.all(reviews.map(attachSummaryMeta));
}

async function getDailyReview(fileName) {
  const content = await readReviewFile(fileName);
  const date = extractReviewDate(fileName);
  const review = {
    id: fileName,
    fileName,
    date,
    label: extractReviewLabel(fileName),
    title: extractReviewTitle(content, fileName),
    content
  };

  return attachSummaryMeta(review);
}

function httpsGetText(url, apiName = 'Tencent quote API') {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 Node FearGreed Demo',
            Accept: 'text/plain,*/*'
          }
        },
        (remoteRes) => {
          if (remoteRes.statusCode !== 200) {
            reject(new Error(`${apiName} responded with ${remoteRes.statusCode}`));
            remoteRes.resume();
            return;
          }

          let raw = '';
          remoteRes.setEncoding('utf8');
          remoteRes.on('data', (chunk) => {
            raw += chunk;
          });
          remoteRes.on('end', () => resolve(raw));
        }
      )
      .on('error', (error) => reject(error));
  });
}

async function fetchRealtimeQuote(symbol) {
  if (!INDEXES[symbol]) {
    throw new Error(`Unsupported index symbol: ${symbol}`);
  }

  const raw = await httpsGetText(`https://qt.gtimg.cn/q=${symbol}`);
  const match = raw.match(/="([^"]+)"/);
  const values = match ? match[1].split('~') : [];
  const price = parseNumber(values[3]);

  if (price === null) {
    throw new Error(`Tencent quote API did not return a realtime price for ${symbol}.`);
  }

  const quoteDate = values[30] && /^\d{8}$/.test(values[30])
    ? `${values[30].slice(0, 4)}-${values[30].slice(4, 6)}-${values[30].slice(6, 8)}`
    : null;
  const quoteTime = values[31] && /^\d{6}$/.test(values[31])
    ? `${values[31].slice(0, 2)}:${values[31].slice(2, 4)}:${values[31].slice(4, 6)}`
    : null;

  return {
    symbol,
    name: values[1] || INDEXES[symbol],
    price,
    date: quoteDate,
    time: quoteTime
  };
}

function serveStatic(reqPath, res) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(reqPath);
  } catch {
    sendJson(res, 400, { error: 'Invalid URL path' });
    return;
  }

  reqPath = decodedPath;
  const isNotificationService = reqPath === '/lib/notificationService.js';
  const rootDir = isNotificationService ? LIB_DIR : PUBLIC_DIR;
  const targetPath = reqPath === '/'
    ? 'index.html'
    : isNotificationService
      ? 'notificationService.js'
      : reqPath.replace(/^\/+/, '');
  const normalized = path.normalize(targetPath);
  const filePath = path.join(rootDir, normalized);
  const relative = path.relative(rootDir, filePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      sendJson(res, 500, { error: 'Failed to read static asset' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(content);
  });
}

async function fetchSinaKLine(symbol, scale, datalen) {
  const sinaUrl = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${encodeURIComponent(symbol)}&scale=${scale}&datalen=${datalen}`;
  return new Promise((resolve, reject) => {
    https
      .get(
        sinaUrl,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 Node FearGreed Demo',
            Accept: 'application/json,*/*'
          }
        },
        (remoteRes) => {
          if (remoteRes.statusCode !== 200) {
            reject(new Error(`Sina API responded with ${remoteRes.statusCode}`));
            remoteRes.resume();
            return;
          }

          let raw = '';
          remoteRes.setEncoding('utf8');
          remoteRes.on('data', (chunk) => {
            raw += chunk;
          });
          remoteRes.on('end', () => {
            try {
              const data = JSON.parse(raw);
              if (!Array.isArray(data)) {
                reject(new Error('Sina API returned invalid data format'));
                return;
              }
              const rows = data.map((item) => ({
                date: item.day || '',
                open: parseNumber(item.open),
                close: parseNumber(item.close),
                high: parseNumber(item.high),
                low: parseNumber(item.low),
                volume: parseNumber(item.volume)
              }));
              resolve(rows);
            } catch (error) {
              reject(new Error(`Failed to parse Sina API response: ${error.message}`));
            }
          });
        }
      )
      .on('error', (error) => reject(error));
  });
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

async function fetchSectorFundFlow() {
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
  const raw = await httpsGetText(
    `https://push2.eastmoney.com/api/qt/clist/get?${params.toString()}`,
    'Eastmoney sector fund flow API'
  );
  const payload = parseEastMoneyPayload(raw);
  const rows = payload && payload.data && Array.isArray(payload.data.diff) ? payload.data.diff : [];

  if (!rows.length) {
    throw new Error('Eastmoney sector fund flow API did not return data.');
  }

  const items = rows.map(normalizeSectorFlowItem);
  return {
    source: 'Eastmoney sector fund flow',
    sectorType: 'industry',
    sortBy: 'mainNetInflow',
    updatedAt: items.find((item) => item.updatedAt)?.updatedAt || new Date().toISOString(),
    items
  };
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname === '/api/daily-reviews') {
    const fileName = requestUrl.searchParams.get('file');
    const handler = fileName ? getDailyReview(fileName) : listDailyReviews();
    handler
      .then((payload) => sendJson(res, 200, fileName ? payload : { reviews: payload }))
      .catch((error) => {
        const statusCode = error.code === 'ENOENT' ? 404 : 500;
        sendJson(res, statusCode, { error: error.message });
      });
    return;
  }
  
  if (requestUrl.pathname === '/api/quote') {
    fetchRealtimeQuote(requestUrl.searchParams.get('symbol'))
      .then((quote) => sendJson(res, 200, quote))
      .catch((error) => sendJson(res, 500, { error: error.message }));
    return;
  }

  if (requestUrl.pathname === '/api/sina-kline') {
    const symbol = requestUrl.searchParams.get('symbol');
    const scale = requestUrl.searchParams.get('scale');
    const datalen = requestUrl.searchParams.get('datalen');
    
    if (!symbol || !scale || !datalen) {
      sendJson(res, 400, { error: 'Missing required parameters: symbol, scale, datalen' });
      return;
    }

    fetchSinaKLine(symbol, scale, datalen)
      .then((data) => sendJson(res, 200, data))
      .catch((error) => sendJson(res, 500, { error: error.message }));
    return;
  }

  if (requestUrl.pathname === '/api/sector-fund-flow') {
    fetchSectorFundFlow()
      .then((payload) => sendJson(res, 200, payload))
      .catch((error) => sendJson(res, 500, { error: error.message }));
    return;
  }

  serveStatic(requestUrl.pathname, res);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
