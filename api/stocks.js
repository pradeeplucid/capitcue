// CapitCue: Nifty 50 heatmap, top gainers/losers, 52-week highs/lows, breadth (Nifty 500)
// Served at https://capitcue.in/api/stocks   Needs env var UPSTOX_ANALYTICS_TOKEN
//
// Index constituents come from NSE's official lists. If NSE can't be reached, it falls back to
// copies in your repo at /data/ind_nifty50list.csv and /data/ind_nifty500list.csv (optional).

const LISTS = {
  n50:  'ind_nifty50list.csv',
  n500: 'ind_nifty500list.csv',
};
const NSE_HOSTS = ['https://nsearchives.nseindia.com/content/indices/', 'https://archives.nseindia.com/content/indices/'];
const LIST_TTL = 12 * 60 * 60 * 1000; // re-read constituent lists every 12 hours
let listCache = { at: 0, n50: null, n500: null };

function parseCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(Boolean);
  const split = (line) => {
    const out = []; let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim()); return out;
  };
  const head = split(lines[0]).map(h => h.toLowerCase());
  const col = (name) => head.findIndex(h => h.includes(name));
  const iName = col('company'), iInd = col('industry'), iSym = col('symbol'), iIsin = col('isin');
  return lines.slice(1).map(split)
    .filter(r => r[iIsin] && /^IN/.test(r[iIsin]))
    .map(r => ({ name: r[iName], industry: r[iInd], symbol: r[iSym], isin: r[iIsin] }));
}

async function getList(file, host) {
  const sources = NSE_HOSTS.map(h => h + file);
  if (host) sources.push(`https://${host}/data/${file}`);
  for (const url of sources) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'text/csv,*/*' } });
      if (!r.ok) continue;
      const rows = parseCsv(await r.text());
      if (rows.length >= 40) return rows;
    } catch (e) { /* try next source */ }
  }
  return null;
}

async function fetchChunk(keys, token) {
  const url = `https://api.upstox.com/v3/market-quote/quotes?instrument_key=${encodeURIComponent(keys.join(','))}`;
  const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Upstox ${r.status}`);
  const body = await r.json();
  const out = {};
  for (const q of Object.values(body.data || {})) out[q.instrument_token] = q;
  return out;
}

// 100 keys per call; if a call fails (e.g. one delisted ISIN), retry that chunk in groups of 10.
async function fetchAll(keys, token) {
  const chunks = [];
  for (let i = 0; i < keys.length; i += 100) chunks.push(keys.slice(i, i + 100));
  const parts = await Promise.all(chunks.map(async (c) => {
    try { return await fetchChunk(c, token); }
    catch (e) {
      const small = [];
      for (let i = 0; i < c.length; i += 10) small.push(c.slice(i, i + 10));
      const got = await Promise.all(small.map(s => fetchChunk(s, token).catch(() => ({}))));
      return Object.assign({}, ...got);
    }
  }));
  return Object.assign({}, ...parts);
}

module.exports = async (req, res) => {
  const token = process.env.UPSTOX_ANALYTICS_TOKEN;
  if (!token) { res.status(500).json({ error: 'UPSTOX_ANALYTICS_TOKEN is not set in Vercel' }); return; }

  try {
    if (!listCache.n500 || Date.now() - listCache.at > LIST_TTL) {
      const host = req.headers && req.headers.host;
      const [n50, n500] = await Promise.all([getList(LISTS.n50, host), getList(LISTS.n500, host)]);
      if (n500) listCache = { at: Date.now(), n50: n50 || listCache.n50, n500 };
    }
    const { n50, n500 } = listCache;
    if (!n500) throw new Error('Could not load Nifty 500 constituents from NSE or /data');

    const quotes = await fetchAll(n500.map(s => `NSE_EQ|${s.isin}`), token);

    const stocks = [];
    for (const s of n500) {
      const q = quotes[`NSE_EQ|${s.isin}`];
      if (!q || typeof q.last_price !== 'number') continue;
      const prev = Number(q.prev_close_price) || (q.last_price - (Number(q.net_change) || 0));
      if (!prev) continue;
      const pct = ((q.last_price - prev) / prev) * 100;
      const hi = q.ohlc && Number(q.ohlc.high), lo = q.ohlc && Number(q.ohlc.low);
      const yh = Number(q.year_high), yl = Number(q.year_low);
      stocks.push({
        s: s.symbol, n: s.name, ind: s.industry, ltp: q.last_price, pct,
        hi52: yh > 0 && hi > 0 && hi >= yh * 0.999,   // touched its 52-week high today
        lo52: yl > 0 && lo > 0 && lo <= yl * 1.001,   // touched its 52-week low today
        yh, yl,
      });
    }

    const n50set = new Set((n50 || []).map(s => s.isin));
    const bySym = Object.fromEntries(n500.map(s => [s.symbol, s.isin]));
    const nifty50 = stocks.filter(x => n50set.has(bySym[x.s]))
      .map(({ s, n, ind, ltp, pct }) => ({ s, n, ind, ltp, pct }));

    const slim = ({ s, n, ltp, pct }) => ({ s, n, ltp, pct });
    const sorted = [...stocks].sort((a, b) => b.pct - a.pct);
    const highs = stocks.filter(x => x.hi52).sort((a, b) => b.pct - a.pct);
    const lows  = stocks.filter(x => x.lo52).sort((a, b) => a.pct - b.pct);

    res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=600');
    res.status(200).json({
      updated: new Date().toISOString(),
      universe: 'Nifty 500',
      count: stocks.length,
      breadth: {
        adv: stocks.filter(x => x.pct > 0).length,
        dec: stocks.filter(x => x.pct < 0).length,
        unch: stocks.filter(x => x.pct === 0).length,
      },
      nifty50,
      gainers: sorted.slice(0, 8).map(slim),
      losers: sorted.slice(-8).reverse().map(slim),
      highs: { count: highs.length, list: highs.slice(0, 10).map(slim) },
      lows:  { count: lows.length,  list: lows.slice(0, 10).map(slim) },
    });
  } catch (err) {
    res.setHeader('Cache-Control', 's-maxage=60');
    res.status(502).json({ error: 'Could not fetch stock data', detail: String(err.message || err) });
  }
};
