// CapitCue: global indices, USD/INR, Brent (Upstox Global Instruments), US yields (US Treasury, FRED backup),
// and MCX Gold & Silver in ₹ (Upstox).
// Served at https://capitcue.in/api/global   Needs env var UPSTOX_ANALYTICS_TOKEN
// Add ?debug=1 to the URL to see every global instrument Upstox offers.

const zlib = require('zlib');

// What we want, and words to find it in Upstox's Global Instruments file (matched on name / trading symbol).
const WANT = [
  { id: 'sp500',    label: 'S&P 500',       region: 'Americas', match: [/^S&P/i, /S&P 500/i, /^US 500/i] },
  { id: 'nasdaq',   label: 'Nasdaq',    region: 'Americas', match: [/US TECH 100/i, /NASDAQ/i] },
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
let cache = { at: 0, global: null, mcx: null, usdfut: null };

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
    .filter(i => i.instrument_type === 'FUT' && String(i.trading_symbol || '').toUpperCase().startsWith(sym + ' FUT ') && Number(i.expiry) > Date.now() + 5 * 864e5)
    .sort((a, b) => Number(a.expiry) - Number(b.expiry))[0];
  const g = pick('GOLD'), s = pick('SILVER'), c = pick('CRUDEOIL');
  return {
    gold:   g ? { key: g.instrument_key, symbol: g.trading_symbol } : null,
    silver: s ? { key: s.instrument_key, symbol: s.trading_symbol } : null,
    crude:  c ? { key: c.instrument_key, symbol: c.trading_symbol } : null,
  };
}

// USD/INR fallback: the next few NSE USDINR futures contracts (weeklies + monthly) from Upstox's NSE file.
// Skips contracts within 2 days of expiry; the handler then shows whichever has the most volume (usually the monthly).
async function findUsdInrFuts() {
  const all = await getJson(ASSETS + 'NSE.json.gz');
  return all
    .filter(i => i.instrument_type === 'FUT' && /^USDINR FUT /i.test(i.trading_symbol || '') && Number(i.expiry) > Date.now() + 2 * 864e5)
    .sort((a, b) => Number(a.expiry) - Number(b.expiry))
    .slice(0, 4)
    .map(i => ({ key: i.instrument_key, symbol: i.trading_symbol }));
}

async function quotes(keys, token) {
  if (!keys.length) return {};
  const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(keys.join(','))}`;
  const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Upstox ${r.status}`);
  const body = await r.json();
  const out = {};
  for (const [k, q] of Object.entries(body.data || {})) {
    if (q.instrument_token) out[q.instrument_token] = q;
    out[k.replace(':', '|')] = q;
  }
  return out;
}
// Fallback for anything the full-quote call didn't return: LTP V3 (last price + previous close).
async function ltpV3(keys, token) {
  if (!keys.length) return {};
  const url = `https://api.upstox.com/v3/market-quote/ltp?instrument_key=${encodeURIComponent(keys.join(','))}`;
  const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
  if (!r.ok) return {};
  const body = await r.json();
  const out = {};
  for (const [k, q] of Object.entries(body.data || {})) {
    const cp = Number(q.cp);
    if (typeof q.last_price !== 'number' || !cp) continue;
    const v = { last_price: q.last_price, net_change: q.last_price - cp };
    if (q.instrument_token) out[q.instrument_token] = v;
    out[k.replace(':', '|')] = v;
  }
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
  if (!q || typeof q.last_price !== 'number' || q.last_price <= 0) return null; // 0 = no trades, not a real price
  const change = Number(q.net_change) || 0, prev = q.last_price - change;
  return { last: q.last_price, change, pct: prev ? (change / prev) * 100 : 0 };
}

// US Treasury yields from the U.S. Treasury's own daily par yield curve (official; the latest US close,
// usually posted the same evening). Falls back to FRED, which runs about a day behind.
async function treasuryYields() {
  const parse = async (year) => {
    const r = await fetch(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Treasury ${r.status}`);
    const lines = (await r.text()).trim().split('\n').map(l => l.replace(/"/g, '').split(','));
    const head = lines[0], i10 = head.indexOf('10 Yr'), i30 = head.indexOf('30 Yr');
    if (i10 < 0 || i30 < 0) throw new Error('Treasury columns changed');
    return lines.slice(1).filter(c => c[0] && !isNaN(parseFloat(c[i10])) && !isNaN(parseFloat(c[i30]))).map(c => ({ date: c[0], t10: parseFloat(c[i10]), t30: parseFloat(c[i30]) }));
  };
  const year = new Date().getUTCFullYear();
  let rows = await parse(year);
  if (rows.length < 2) rows = rows.concat(await parse(year - 1).catch(() => []));   // early January: need the prior year's last day
  if (rows.length < 2) throw new Error('Treasury: not enough rows');
  const [a, b] = rows;                                                               // newest first
  const iso = a.date.replace(/^(\d\d)\/(\d\d)\/(\d{4})$/, '$3-$1-$2');
  const mk = (k) => ({ last: a[k], bps: Math.round((a[k] - b[k]) * 100), date: iso });
  return { us10: mk('t10'), us30: mk('t30') };
}

// US Treasury yields from FRED (public data; daily, runs about a day behind the Treasury's own feed).
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
      const [g, m, u] = await Promise.all([loadGlobalList().catch(() => null), loadMcx().catch(() => null), findUsdInrFuts().catch(() => null)]);
      cache = { at: Date.now(), global: g || cache.global, mcx: m || cache.mcx, usdfut: (u && u.length) ? u : cache.usdfut };
    }

    // Match wanted instruments against the file
    const list = cache.global || [];
    const found = {};
    for (const w of WANT) {
      const hit = list.find(i => w.match.some(rx => rx.test(i.name || '') || rx.test(i.trading_symbol || '')));
      if (hit) found[w.id] = hit.instrument_key;
    }

    const mcx = cache.mcx || {};
    const usdfuts = cache.usdfut || [];
    const keys = [...Object.values(found), mcx.gold && mcx.gold.key, mcx.silver && mcx.silver.key, mcx.crude && mcx.crude.key, ...usdfuts.map(c => c.key)].filter(Boolean);
    const [q, ylds] = await Promise.all([
      Promise.all([
        quotesTolerant(keys.filter(k => !k.startsWith('GLOBAL_INDICATOR')), token),
        quotesTolerant(keys.filter(k => k.startsWith('GLOBAL_INDICATOR')), token).catch(() => ({})),
      ]).then(([a, b]) => Object.assign(a, b)).then(async (got) => {
        const gaps = keys.filter(k => !got[k] || typeof got[k].last_price !== 'number');
        return gaps.length ? Object.assign(got, await ltpV3(gaps, token).catch(() => ({}))) : got;
      }),
      treasuryYields().catch(async () => {
        const [us10, us30] = await Promise.all([fredYield('DGS10').catch(() => null), fredYield('DGS30').catch(() => null)]);
        return { us10, us30 };
      }),
    ]);

    const markets = [], missing = [];
    for (const w of WANT) {
      const s = found[w.id] && shape(q[found[w.id]]);
      if (s) markets.push({ id: w.id, label: w.label, region: w.region, ...s });
      else missing.push(w.label);
    }

    // Upstox rejects GLOBAL_INDICATOR|USDINR for now, so fall back to the NSE USDINR futures price
    // (the most-traded of the next few contracts; thin weeklies can show stale or zero prices).
    const usdfut = usdfuts.filter(c => shape(q[c.key]))
      .sort((a, b) => (Number(q[b.key].volume) || 0) - (Number(q[a.key].volume) || 0))[0];
    if (!markets.some(m => m.id === 'usdinr') && usdfut) {
      const s = shape(q[usdfut.key]);
      if (s) {
        markets.push({ id: 'usdinr', label: 'USD/INR', region: 'FX', ...s, source: usdfut.symbol });
        const i = missing.indexOf('USD/INR'); if (i > -1) missing.splice(i, 1);
      }
    }

    const bullion = {};
    if (mcx.gold)   { const s = shape(q[mcx.gold.key]);   if (s) bullion.gold   = { ...s, contract: mcx.gold.symbol,   unit: '₹ per 10 g' }; }
    if (mcx.silver) { const s = shape(q[mcx.silver.key]); if (s) bullion.silver = { ...s, contract: mcx.silver.symbol, unit: '₹ per kg' }; }

    let crude = null;
    if (mcx.crude) { const s = shape(q[mcx.crude.key]); if (s) crude = { ...s, contract: mcx.crude.symbol, unit: '₹ per barrel' }; }

    const out = {
      updated: new Date().toISOString(),
      markets, missing, bullion, crude,
      yields: { us10: ylds.us10, us30: ylds.us30 },
      globalFileFound: !!cache.global,
      usdinrSource: (markets.find(m => m.id === 'usdinr') || {}).source || null,
    };
    if (req.query && req.query.debug) {
      out.catalog = list.map(i => ({ name: i.name, key: i.instrument_key, latency: i.latency }));
      out.usdinrCandidates = usdfuts.map(c => ({ ...c, last: q[c.key] && q[c.key].last_price, volume: q[c.key] && q[c.key].volume }));
      // Raw Upstox replies for anything missing, to see why it isn't returning a price
      const probe = WANT.filter(w => found[w.id] && !markets.some(m => m.id === w.id)).map(w => found[w.id]);
      out.probe = await Promise.all(probe.map(async (k) => {
        const res1 = await Promise.all([
          `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(k)}`,
          `https://api.upstox.com/v3/market-quote/ltp?instrument_key=${encodeURIComponent(k)}`,
        ].map(async (u) => {
          try {
            const r = await fetch(u, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
            return { url: u.split('?')[0], status: r.status, body: (await r.text()).slice(0, 400) };
          } catch (e) { return { url: u.split('?')[0], error: String(e.message || e) }; }
        }));
        return { key: k, replies: res1 };
      }));
    }

    res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=600');
    res.status(200).json(out);
  } catch (err) {
    res.setHeader('Cache-Control', 's-maxage=60');
    res.status(502).json({ error: 'Could not fetch global data', detail: String(err.message || err) });
  }
};
