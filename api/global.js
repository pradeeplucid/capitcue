// CapitCue: global indices, USD/INR, Brent (Upstox Global Instruments), US yields (FRED),
// and MCX Gold & Silver in ₹ (Upstox).
// Served at https://capitcue.in/api/global   Needs env var UPSTOX_ANALYTICS_TOKEN
// Add ?debug=1 to the URL to see every global instrument Upstox offers.

const zlib = require('zlib');

// What we want, and words to find it in Upstox's Global Instruments file (matched on name / trading symbol).
const WANT = [
  { id: 'sp500',    label: 'S&P 500',       region: 'Americas', match: [/^S&P/i, /S&P 500/i, /^US 500/i] },
  { id: 'nasdaq',   label: 'Nasdaq 100',    region: 'Americas', match: [/US TECH 100/i, /NASDAQ/i] },
  { id: 'dow',      label: 'Dow Jones',     region: 'Americas', match: [/DOW JONES/i, /\^DJI/i] },
  { id: 'nikkei',   label: 'Nikkei 225',    region: 'Asia',     match: [/NIKKEI/i] },
  { id: 'kospi',    label: 'KOSPI',         region: 'Asia',     match: [/KOSPI/i] },
  { id: 'hangseng', label: 'Hang Seng',     region: 'Asia',     match: [/HANG SENG/i] },
  { id: 'shanghai', label: 'Shanghai Comp', region: 'Asia',     match: [/SHANGHAI/i, /SSE COMP/i] },
  { id: 'dax',      label: 'DAX',           region: 'Europe',   match: [/\bDAX\b/i] },
  { id: 'ftse',     label: 'FTSE 100',      region: 'Europe',   match: [/FTSE 100/i, /\bFTSE\b/i] },
  { id: 'cac',      label: 'CAC 40',        region: 'Europe',   match: [/\bCAC\b/i] },
  { id: 'giftnifty',label: 'GIFT Nifty',    region: 'India',    match: [/GIFT NIFTY/i] },
  { id: 'usdinr',   label: 'USD/INR',       region: 'FX',       match: [/USD ?INR/i] },
  { id: 'brent',    label: 'Brent crude',   region: 'FX',       match: [/BRENT/i, /^BZUSD$/i] },
];

const ASSETS = 'https://assets.upstox.com/market-quote/instruments/exchange/';
const GLOBAL_FILES = ['global.json.gz', 'GLOBAL.json.gz', 'global.json', 'GLOBAL.json'];
const TTL = 12 * 60 * 60 * 1000;
let cache = { at: 0, global: null, mcx: null };

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const text = (buf[0] === 0x1f && buf[1] === 0x8b) ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return JSON.parse(text);
}

async function loadGlobalList() {
  for (const f of GLOBAL_FILES) {
    try { const j = await getJson(ASSETS + f); if (Array.isArray(j) && j.length) return j; } catch (e) {}
  }
  return null;
}

// Nearest MCX futures contract for GOLD / SILVER at least 5 days from expiry.
async function loadMcx() {
  const all = await getJson(ASSETS + 'MCX.json.gz');
  const pick = (sym) => all
    .filter(i => i.instrument_type === 'FUT' && (i.underlying_symbol === sym || i.name === sym) && Number(i.expiry) > Date.now() + 5 * 864e5)
    .sort((a, b) => Number(a.expiry) - Number(b.expiry))[0];
  const g = pick('GOLD'), s = pick('SILVER');
  return {
    gold:   g ? { key: g.instrument_key, symbol: g.trading_symbol } : null,
    silver: s ? { key: s.instrument_key, symbol: s.trading_symbol } : null,
  };
}

async function quotes(keys, token) {
  if (!keys.length) return {};
  const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(keys.join(','))}`;
  const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Upstox ${r.status}`);
  const body = await r.json();
  const out = {};
  for (const q of Object.values(body.data || {})) out[q.instrument_token] = q;
  return out;
}
async function quotesTolerant(keys, token) {
  try { return await quotes(keys, token); }
  catch (e) {
    const parts = await Promise.all(keys.map(k => quotes([k], token).catch(() => ({}))));
    return Object.assign({}, ...parts);
  }
}
function shape(q) {
  if (!q || typeof q.last_price !== 'number') return null;
  const change = Number(q.net_change) || 0, prev = q.last_price - change;
  return { last: q.last_price, change, pct: prev ? (change / prev) * 100 : 0 };
}

// US Treasury yields from FRED (public data; daily, previous business day).
async function fredYield(series) {
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}&cosd=${since}`);
  if (!r.ok) throw new Error(`FRED ${r.status}`);
  const rows = (await r.text()).trim().split('\n').slice(1)
    .map(l => l.split(',')).filter(c => c[1] && !isNaN(parseFloat(c[1])));
  if (rows.length < 2) return null;
  const [d1, v1] = rows[rows.length - 1], v0 = rows[rows.length - 2][1];
  return { last: parseFloat(v1), bps: Math.round((parseFloat(v1) - parseFloat(v0)) * 100), date: d1 };
}

module.exports = async (req, res) => {
  const token = process.env.UPSTOX_ANALYTICS_TOKEN;
  if (!token) { res.status(500).json({ error: 'UPSTOX_ANALYTICS_TOKEN is not set in Vercel' }); return; }

  try {
    if (!cache.global || !cache.mcx || Date.now() - cache.at > TTL) {
      const [g, m] = await Promise.all([loadGlobalList().catch(() => null), loadMcx().catch(() => null)]);
      cache = { at: Date.now(), global: g || cache.global, mcx: m || cache.mcx };
    }

    // Match wanted instruments against the file
    const list = cache.global || [];
    const found = {};
    for (const w of WANT) {
      const hit = list.find(i => w.match.some(rx => rx.test(i.name || '') || rx.test(i.trading_symbol || '')));
      if (hit) found[w.id] = hit.instrument_key;
    }

    const mcx = cache.mcx || {};
    const keys = [...Object.values(found), mcx.gold && mcx.gold.key, mcx.silver && mcx.silver.key].filter(Boolean);
    const [q, y10, y30] = await Promise.all([
      quotesTolerant(keys, token),
      fredYield('DGS10').catch(() => null),
      fredYield('DGS30').catch(() => null),
    ]);

    const markets = [], missing = [];
    for (const w of WANT) {
      const s = found[w.id] && shape(q[found[w.id]]);
      if (s) markets.push({ id: w.id, label: w.label, region: w.region, ...s });
      else missing.push(w.label);
    }

    const bullion = {};
    if (mcx.gold)   { const s = shape(q[mcx.gold.key]);   if (s) bullion.gold   = { ...s, contract: mcx.gold.symbol,   unit: '₹ per 10 g' }; }
    if (mcx.silver) { const s = shape(q[mcx.silver.key]); if (s) bullion.silver = { ...s, contract: mcx.silver.symbol, unit: '₹ per kg' }; }

    const out = {
      updated: new Date().toISOString(),
      markets, missing, bullion,
      yields: { us10: y10, us30: y30 },
      globalFileFound: !!cache.global,
    };
    if (req.query && req.query.debug) out.catalog = list.map(i => ({ name: i.name, key: i.instrument_key, latency: i.latency }));

    res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=600');
    res.status(200).json(out);
  } catch (err) {
    res.setHeader('Cache-Control', 's-maxage=60');
    res.status(502).json({ error: 'Could not fetch global data', detail: String(err.message || err) });
  }
};
