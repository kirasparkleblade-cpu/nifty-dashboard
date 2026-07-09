// api/nifty-candle.js
// Vercel serverless function — fetches Yahoo chart data server-side so the
// browser never has to deal with CORS or unreliable public proxies.
//
// Uses Node's built-in https module (not the global fetch API) so this
// works regardless of which Node.js runtime version your project is on.
//
// Usage from the widget:
//   /api/nifty-candle?symbol=%5ENSEI&interval=30m&range=1mo
//
// Place this file at:  <repo-root>/api/nifty-candle.js

const https = require('https');

function getJSON(host, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      path: path,
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body });
      });
    });

    req.on('error', reject);
    req.setTimeout(9000, () => {
      req.destroy(new Error('upstream request timed out'));
    });
    req.end();
  });
}

module.exports = async (req, res) => {
  const query = req.query || {};
  const symbol = query.symbol || '^NSEI';
  const interval = query.interval || '30m';
  const range = query.range || '1mo';

  const path =
    `/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;

  const hosts = ['query2.finance.yahoo.com', 'query1.finance.yahoo.com'];
  let lastError = null;

  for (const host of hosts) {
    try {
      const { statusCode, body } = await getJSON(host, path);

      if (statusCode < 200 || statusCode >= 300) {
        lastError = `${host} -> HTTP ${statusCode}`;
        continue;
      }

      let json;
      try {
        json = JSON.parse(body);
      } catch (e) {
        lastError = `${host} -> invalid JSON in response`;
        continue;
      }

      if (json && json.chart && json.chart.error) {
        lastError = `${host} -> ${json.chart.error.description || 'Yahoo error'}`;
        continue;
      }
      if (!json || !json.chart || !json.chart.result || !json.chart.result[0]) {
        lastError = `${host} -> empty result`;
        continue;
      }

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=90');
      res.status(200).json(json);
      return;
    } catch (e) {
      lastError = `${host} -> ${e.message}`;
    }
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(502).json({
    error: true,
    message: 'Yahoo fetch failed on all hosts',
    detail: lastError,
    symbol,
    interval,
    range,
    updatedAt: new Date().toISOString()
  });
};
