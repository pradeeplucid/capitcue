// CapitCue live index feed — Vercel serverless function
// Lives at: /api/market.js in your GitHub repo  ->  served at https://capitcue.in/api/market
// Needs a Vercel environment variable: UPSTOX_ANALYTICS_TOKEN (never put the token in index.html)

const INSTRUMENTS = {
  nifty:     'NSE_INDEX|Nifty 50',
  sensex:    'BSE_INDEX|SENSEX',
  banknifty: 'NSE_INDEX|Nifty Bank',
  vix:       'NSE_INDEX|India VIX',
};

module.exports = async (req, res) => {
  const token = process.env.UPSTOX_ANALYTICS_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'UPSTOX_ANALYTICS_TOKEN is not set in Vercel' });
    return;
  }

  try {
    const keys = encodeURIComponent(Object.values(INSTRUMENTS).join(','));
    const r = await fetch(`https://api.upstox.com/v2/market-quote/quotes?instrument_key=${keys}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Upstox responded ${r.status}`);
    const body = await r.json();

    // Index the response by instrument_token so we don't depend on how Upstox formats the keys
    const byToken = {};
    for (const q of Object.values(body.data || {})) byToken[q.instrument_token] = q;

    const quotes = {};
    for (const [name, key] of Object.entries(INSTRUMENTS)) {
      const q = byToken[key];
      if (!q || typeof q.last_price !== 'number') continue;
      const change = Number(q.net_change) || 0;
      const prev = q.last_price - change;
      quotes[name] = {
        last: q.last_price,
        change,
        pct: prev ? (change / prev) * 100 : 0,
      };
    }

    // Vercel's CDN caches this for 3 minutes, so Upstox is called at most ~20 times an hour
    res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=600');
    res.status(200).json({ updated: new Date().toISOString(), quotes });
  } catch (err) {
    res.setHeader('Cache-Control', 's-maxage=60');
    res.status(502).json({ error: 'Could not fetch market data', detail: String(err.message || err) });
  }
};
