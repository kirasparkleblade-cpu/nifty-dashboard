// lib/nseStocks.js
// Builds the scan universe: NSE Midcap 150 + Smallcap 250 (i.e. "midcap and below the top 100").
// Strategy: try to pull the live, always-current constituent lists straight from NSE's own
// archives at request time. If NSE blocks/changes the URL (it does this periodically), fall back
// to the static Midcap150 snapshot baked in below so the scanner never just dies.
//
// Want a different universe? Edit UNIVERSE_URLS below (e.g. drop smallcap250, add microcap250, etc).

const UNIVERSE_URLS = [
  "https://nsearchives.nseindia.com/content/indices/ind_niftymidcap150list.csv",
  "https://nsearchives.nseindia.com/content/indices/ind_niftysmallcap250list.csv",
];

const NSE_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/csv,*/*",
};

function parseCsvSymbols(csvText) {
  const lines = csvText.trim().split("\n");
  const symbols = [];
  for (let i = 1; i < lines.length; i++) {
    // Company Name,Industry,Symbol,Series,ISIN Code  -- Symbol is column index 2
    const cols = lines[i].split(",");
    if (cols.length >= 3) {
      const symbol = cols[2].trim();
      if (symbol) symbols.push(symbol);
    }
  }
  return symbols;
}

// Static snapshot (Nifty Midcap 150, pulled mid-2026) used only if the live fetch fails.
const FALLBACK_MIDCAP_150 = [
  "360ONE","3MINDIA","ACC","AIAENG","APLAPOLLO","AUBANK","AWL","ABBOTINDIA","ATGL","ABCAPITAL",
  "AJANTPHARM","ALKEM","ANTHEM","APARINDS","APOLLOTYRE","ASHOKLEY","ASTRAL","AUROPHARMA","AIIL","BSE",
  "BAJAJHFL","BALKRISIND","BANKINDIA","MAHABANK","BERGEPAINT","BDL","BHARATFORG","BHEL","BHARTIHEXA","GROWW",
  "BIOCON","BLUESTARCO","CRISIL","COCHINSHIP","COFORGE","COLPAL","CONCOR","COROMANDEL","DABUR","DALBHARAT",
  "DIXON","ENDURANCE","ESCORTS","EXIDEIND","NYKAA","FEDERALBNK","FORTIS","GVT&D","GMRAIRPORT","GICRE",
  "GLAXO","GLENMARK","MEDANTA","GODFRYPHLP","GODREJIND","GODREJPROP","FLUOROCHEM","HDBFS","HAVELLS","HEROMOTOCO",
  "HEXT","HINDPETRO","POWERINDIA","HONAUT","HUDCO","ICICIGI","ICICIAMC","ICICIPRULI","IDFCFIRSTB","ITCHOTELS",
  "INDIANB","IRCTC","IREDA","INDUSTOWER","INDUSINDBK","NAUKRI","IPCALAB","JKCEMENT","JSWENERGY","JSWINFRA",
  "JSL","JUBLFOOD","KPRMILL","KEI","KPITTECH","KALYANKJIL","LTF","LTTS","LGEINDIA","LICHSGFIN",
  "LAURUSLABS","LENSKART","LICI","LINDEINDIA","LLOYDSME","LUPIN","MRF","M&MFIN","MANKIND","MARICO",
  "MFSL","MOTILALOFS","MPHASIS","MCX","NHPC","NLCINDIA","NMDC","NTPCGREEN","NATIONALUM","NAM-INDIA",
  "OBEROIRLTY","OIL","PAYTM","OFSS","POLICYBZR","PIIND","PAGEIND","PATANJALI","PERSISTENT","PETRONET",
  "PHOENIXLTD","POLYCAB","PREMIERENE","PRESTIGE","RADICO","RVNL","SBICARD","SJVN","SRF","SCHAEFFLER",
  "SAIL","SUNDARMFIN","SUPREMEIND","SUZLON","SWIGGY","TATACOMM","TATAELXSI","TATAINVEST","NIACL","THERMAX",
  "TORNTPOWER","TIINDIA","UNOMINDA","UPL","UBL","VMM","IDEA","VOLTAS","WAAREEENER","YESBANK",
];

async function fetchCsv(url) {
  const res = await fetch(url, { headers: NSE_FETCH_HEADERS });
  if (!res.ok) throw new Error(`NSE fetch failed (${res.status}) for ${url}`);
  const text = await res.text();
  if (!text.includes("Symbol")) throw new Error(`Unexpected NSE response for ${url}`);
  return parseCsvSymbols(text);
}

/**
 * Returns { symbols: string[] (no .NS suffix), source: 'live'|'fallback' }
 */
async function getStockUniverse() {
  try {
    const results = await Promise.all(UNIVERSE_URLS.map(fetchCsv));
    const merged = [...new Set(results.flat())];
    if (merged.length < 50) throw new Error("Live NSE list looked too small, distrust it");
    return { symbols: merged, source: "live" };
  } catch (err) {
    return { symbols: [...new Set(FALLBACK_MIDCAP_150)], source: "fallback", error: String(err) };
  }
}

module.exports = { getStockUniverse, FALLBACK_MIDCAP_150 };
