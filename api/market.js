// CapitCue: indices + sector indices (Upstox via Vercel)
// Served at https://capitcue.in/api/market   Needs env var UPSTOX_ANALYTICS_TOKEN

const INDICES = {
  nifty:     'NSE_INDEX|Nifty 50',
  sensex:    'BSE_INDEX|SENSEX',
  banknifty: 'NSE_INDEX|Nifty Bank',
  vix:       'NSE_INDEX|India VIX',
};

// Sector indices. If Upstox names any of these differently, it shows up in "missing" in the response.
const SECTORS = [
  ['Nifty IT',           'NSE_INDEX|Nifty IT'],
  ['Nifty Auto',         'NSE_INDEX|Nifty Auto'],
  ['Nifty Pharma',       'NSE_INDEX|Nifty Pharma'],
  ['Nifty FMCG',         'NSE_INDEX|Nifty FMCG'],
  ['Nifty Metal',        'NSE_INDEX|Nifty Metal'],
  ['Nifty Realty',       'NSE_INDEX|Nifty Realty'],
  ['Nifty Energy',       'NSE_INDEX|Nifty Energy'],
  ['Nifty PSU Bank',     'NSE_INDEX|Nifty PSU Bank'],
  ['Nifty Pvt Bank',     'NSE_INDEX|Nifty Pvt Bank'],
  ['Nifty Fin Service',  'NSE_INDEX|Nifty Fin Service'],
  ['Nifty Media',        'NSE_INDEX|Nifty Media'],
  ['Nifty Healthcare',   'NSE_INDEX|NIFTY HEALTHCARE'],
  ['Nifty Consumer Durables', 'NSE_INDEX|NIFTY CONSR DURBL'],
  ['Nifty Oil & Gas',    'NSE_INDEX|NIFTY OIL AND GAS'],
];

async function fetchQuotes(keys, token) {
  const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(keys.join(','))}`;
  const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Upstox ${r.status}`);
  const body = await r.json();
  const out = {};
  for (const q of Object.values(body.data || {})) out[q.instrument_token] = q;
  return out;
}

// Try all keys at once; if Upstox rejects the batch (e.g. one bad key), retry one by one and skip failures.
async function fetchTolerant(keys, token) {
  try { return await fetchQuotes(keys, token); }
  catch (e) {
    const parts = await Promise.all(keys.map(k => fetchQuotes([k], token).catch(() => ({}))));
    return Object.assign({}, ...parts);
  }
}

function shape(q) {
  if (!q || typeof q.last_price !== 'number') return null;
  const change = Number(q.net_change) || 0;
  const prev = q.last_price - change;
  return { last: q.last_price, change, pct: prev ? (change / prev) * 100 : 0 };
}

module.exports = async (req, res) => {
  const token = process.env.UPSTOX_ANALYTICS_TOKEN;
  if (!token) { res.status(500).json({ error: 'UPSTOX_ANALYTICS_TOKEN is not set in Vercel' }); return; }

  try {
    const [main, sec] = await Promise.all([
      fetchQuotes(Object.values(INDICES), token),
      fetchTolerant(SECTORS.map(s => s[1]), token),
    ]);

    const quotes = {};
    for (const [name, key] of Object.entries(INDICES)) { const s = shape(main[key]); if (s) quotes[name] = s; }

    const sectors = [], missing = [];
    for (const [name, key] of SECTORS) {
      const s = shape(sec[key]);
      if (s) sectors.push({ name, ...s }); else missing.push(key);
    }
    sectors.sort((a, b) => b.pct - a.pct);

    res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=600');
    res.status(200).json({ updated: new Date().toISOString(), quotes, sectors, missing });
  } catch (err) {
    res.setHeader('Cache-Control', 's-maxage=60');
    res.status(502).json({ error: 'Could not fetch market data', detail: String(err.message || err) });
  }
};
