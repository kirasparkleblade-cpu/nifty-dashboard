// api/gift-nifty.js
// Proxies the user-supplied Google Apps Script endpoint for GIFT Nifty.
// NOTE: I could not preview this endpoint's JSON shape ahead of time — my
// fetch tool respects robots.txt and Google Apps Script disallows automated
// preview. This does NOT mean the endpoint itself is broken; Apps Script
// web apps are normal JSON APIs once deployed, this is just a limitation of
// my preview step. This handler tries several likely key names and also
// returns the raw payload so field mapping can be corrected in one edit if
// something comes back empty.

const GIFT_URL =
  "https://script.google.com/a/macros/mnclgroup.com/s/AKfycbydtixjyVlciFzoV1BOu9bUXKtBAPb7eav_rygcgK71mExjLSN3kno_00l0r7WgHsiR/exec";

function pick(obj, keys) {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return null;
}

export default async function handler(req, res) {
  try {
    const upstream = await fetch(GIFT_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; QuantMonarchWidget/1.0)",
        Accept: "application/json, text/plain, */*",
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "Upstream fetch failed", status: upstream.status });
    }

    const raw = await upstream.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // Some Apps Script deployments return text or HTML on misconfiguration —
      // surface it raw so it's obvious what's wrong.
      return res.status(502).json({ error: "Response wasn't valid JSON", rawText: raw.slice(0, 500) });
    }

    // Handle either a flat object or an array with one row.
    const row = Array.isArray(data) ? data[0] : data;

    const price = pick(row, ["giftNifty", "gift_nifty", "GIFT_NIFTY", "price", "last", "value", "ltp"]);
    const change = pick(row, ["change", "chg", "netChange", "pointChange"]);
    const changePct = pick(row, ["changePercent", "pChange", "percentChange"]);

    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({
      updatedAt: new Date().toISOString(),
      price,
      change,
      changePct,
      raw: row, // debug aid — remove once field mapping is confirmed
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
