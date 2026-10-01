// CapitCue: Market Pulse headlines from public RSS feeds (headline + link + source only; no article text).
// Served at https://capitcue.in/api/news   No token needed.
// Add ?debug=1 to see how many items each feed returned.

const FEEDS = [
  { name: 'Economic Times',    url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', max: 3 },
  { name: 'Business Standard', url: 'https://www.business-standard.com/rss/markets-106.rss',                max: 3 },
  { name: 'Mint',              url: 'https://www.livemint.com/rss/markets',                                  max: 3 },
  { name: 'BusinessLine',      url: 'https://www.thehindubusinessline.com/markets/feeder/default.rss',       max: 3 },
  { name: 'BSE notice',        url: 'https://www.bseindia.com/data/xml/notices.xml',                         max: 2 },
];
const MAX_AGE = 36 * 60 * 60 * 1000;   // ignore anything older than 36 hours (covers weekends)
const TOTAL = 8;

// CapitCue shows cues and data, not buy/sell calls: drop headlines that read like recommendations.
const CALLS = /\b(buy|sell|accumulate|targets?|top picks?|stock picks?|multibagger|recommend\w*|should you)\b/i;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function clean(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/(\w)#39;/g, "$1'")                      // some feeds drop the "&" in &#39;
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] || m)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? clean(m[1]) : ''; };

function parseFeed(xml, source) {
  return (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []).map(block => {
    const link = tag(block, 'link');
    return { title: tag(block, 'title'), link, source: source.name, ts: Date.parse(tag(block, 'pubDate')) };
  }).filter(i => i.title && /^https?:\/\//i.test(i.link) && Number.isFinite(i.ts));
}

async function load(feed) {
  const r = await fetch(feed.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/rss+xml,text/xml,*/*' },
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return parseFeed(await r.text(), feed);
}

module.exports = async (req, res) => {
  try {
    const results = await Promise.allSettled(FEEDS.map(load));
    const now = Date.now(), seen = new Set(), items = [];
    results.forEach((r, k) => {
      if (r.status !== 'fulfilled') return;
      r.value
        .filter(i => now - i.ts < MAX_AGE && i.ts < now + 3600e3 && !CALLS.test(i.title))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, FEEDS[k].max)
        .forEach(i => {
          const key = i.title.toLowerCase().slice(0, 60);
          if (!seen.has(key)) { seen.add(key); items.push(i); }
        });
    });
    items.sort((a, b) => b.ts - a.ts);

    // Keep one slot for the latest exchange notice so it isn't crowded out by the newsier feeds.
    const notice = items.find(i => i.source === 'BSE notice');
    const news = items.filter(i => i.source !== 'BSE notice').slice(0, notice ? TOTAL - 1 : TOTAL);
    const picked = (notice ? [...news, notice] : news).sort((a, b) => b.ts - a.ts);

    const out = { updated: new Date().toISOString(), items: picked };
    if (req.query && req.query.debug) {
      out.feeds = results.map((r, k) => ({ source: FEEDS[k].name, ok: r.status === 'fulfilled', items: r.status === 'fulfilled' ? r.value.length : 0, error: r.status === 'rejected' ? String(r.reason && r.reason.message || r.reason) : undefined }));
    }
    if (!out.items.length) { res.setHeader('Cache-Control', 's-maxage=60'); res.status(502).json({ error: 'No headlines available', ...out }); return; }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    res.status(200).json(out);
  } catch (err) {
    res.setHeader('Cache-Control', 's-maxage=60');
    res.status(502).json({ error: 'Could not fetch headlines', detail: String(err.message || err) });
  }
};
