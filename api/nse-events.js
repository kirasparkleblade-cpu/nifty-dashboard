// api/nse-events.js
// NSE's event-calendar endpoint sits behind a JS-based bot challenge
// (Akamai/PerimeterX-style — a page with <meta content="noindex, nofollow">
// that requires executing JavaScript to pass). A plain fetch() with headers
// and cookies can't solve that — there's no JS engine running to solve the
// challenge. This uses a real (headless) Chromium via Puppeteer instead.
//
// IMPORTANT DESIGN CHOICE: the entire request — not just cookie collection —
// happens inside the browser context. We navigate the actual browser to the
// homepage (to pass the challenge), then navigate that SAME browser to the
// API URL and read the page body. We deliberately do NOT extract cookies
// and make a separate plain fetch() afterward — bot detection like this
// often fingerprints the TLS/HTTP handshake itself, not just cookies, so a
// bare Node fetch() could still get blocked even with valid cookies.
//
// REQUIRES: @sparticuz/chromium + puppeteer-core in package.json, and
// vercel.json giving this specific function more time/memory (browser
// launches are slow and memory-hungry compared to a normal fetch).
//
// KNOWN RISK: @sparticuz/chromium's bundled binary is close to Vercel's
// deployment size limit on the Hobby plan. If deployment fails with a size
// error, that's the Hobby plan's ~50MB function limit — Pro plan raises it.

import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const REAL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function formatDDMMYYYY(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return null;
}

function categorize(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("result")) return "Earnings";
  if (t.includes("dividend")) return "Dividend";
  if (t.includes("bonus") || t.includes("split") || t.includes("buyback")) return "Corp Action";
  if (t.includes("agm") || t.includes("egm") || t.includes("annual general") || t.includes("general meeting")) return "AGM/EGM";
  if (t.includes("board meeting") || t.includes("bm ")) return "Board Meeting";
  return "Other";
}

async function fetchViaBrowser(eventUrl) {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(REAL_UA);
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });

    // Step 1: visit the homepage in a real browser context — this is what
    // lets the challenge JS execute and the session get marked as human.
    await page.goto("https://www.nseindia.com/", { waitUntil: "networkidle2", timeout: 30000 });
    // Give any challenge JS a moment to finish running and set cookies.
    await new Promise((r) => setTimeout(r, 3000));

    // Step 2: navigate the SAME browser session to the actual API URL.
    await page.goto(eventUrl, { waitUntil: "networkidle2", timeout: 30000 });
    const bodyText = await page.evaluate(() => document.body.innerText);

    return bodyText;
  } finally {
    await browser.close();
  }
}

export default async function handler(req, res) {
  try {
    const today = new Date();
    const to = new Date();
    to.setDate(to.getDate() + 30);

    const fromDate = req.query?.from_date || formatDDMMYYYY(today);
    const toDate = req.query?.to_date || formatDDMMYYYY(to);
    const index = req.query?.index || "equities";

    const eventUrl = `https://www.nseindia.com/api/event-calendar?index=${encodeURIComponent(
      index
    )}&from_date=${encodeURIComponent(fromDate)}&to_date=${encodeURIComponent(toDate)}`;

    const rawText = await fetchViaBrowser(eventUrl);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(502).json({
        error: "NSE returned non-JSON even via headless browser — challenge may have changed",
        bodySnippet: rawText.slice(0, 300),
      });
    }

    const list = Array.isArray(data) ? data : data?.data || [];

    const events = list.map((ev) => {
      const symbol = pick(ev, ["symbol", "SYMBOL", "Symbol"]);
      const company = pick(ev, ["company", "companyName", "COMPANY", "comp"]);
      const purpose = pick(ev, ["purpose", "bm_desc", "subject", "PURPOSE", "description"]);
      const date = pick(ev, ["date", "bm_date", "boardMeetingDate", "meetingDate", "DATE"]);

      return {
        symbol,
        company,
        purpose,
        date,
        category: categorize(purpose),
      };
    });

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({
      count: events.length,
      updatedAt: new Date().toISOString(),
      events,
      raw: list.slice(0, 2),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
