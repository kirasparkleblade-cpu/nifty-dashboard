(function(){
  const canvas = document.getElementById('chart');
  const ctx = canvas.getContext('2d');
  const wrap = document.getElementById('chartWrap');
  const tooltip = document.getElementById('tooltip');
  const errBox = document.getElementById('error');
  const loadingBox = document.getElementById('loading');
  const statusEl = document.getElementById('status');

  const inSymbol = document.getElementById('inSymbol');
  const inInterval = document.getElementById('inInterval');
  const inRange = document.getElementById('inRange');
  const btnLoad = document.getElementById('btnLoad');

  let candles = []; // {t, o, h, l, c, v}
  let hoverIndex = -1;
  let currentMeta = { symbol: '^NSEI' };

  const rootStyle = getComputedStyle(document.documentElement);
  const COLOR = {
    border: rootStyle.getPropertyValue('--border').trim() || '#E9E9E7',
    text: rootStyle.getPropertyValue('--text').trim() || '#37352F',
    muted: rootStyle.getPropertyValue('--muted').trim() || '#9B9A97',
    bull: rootStyle.getPropertyValue('--bull').trim() || '#0F7B4D',
    bullSoft: rootStyle.getPropertyValue('--bull-soft').trim() || '#DDF3E4',
    bear: rootStyle.getPropertyValue('--bear').trim() || '#C4362E',
    bearSoft: rootStyle.getPropertyValue('--bear-soft').trim() || '#FBE4E1',
    bg: rootStyle.getPropertyValue('--bg').trim() || '#FFFFFF'
  };

  function fmtNum(n, decimals){
    if (n === null || n === undefined || isNaN(n)) return '—';
    if (decimals === undefined) decimals = n < 10 ? 4 : 2;
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  function fmtVol(v){
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (v >= 1e7) return (v/1e7).toFixed(2) + 'Cr';
    if (v >= 1e5) return (v/1e5).toFixed(2) + 'L';
    if (v >= 1e3) return (v/1e3).toFixed(1) + 'K';
    return String(v);
  }
  function fmtDate(ts, interval){
    const d = new Date(ts * 1000);
    if (interval === '1d' || interval === '1wk' || interval === '1mo'){
      return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    }
    return d.toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', hour12:false });
  }

  async function fetchJSON(symbol, interval, range){
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    const proxies = [
      (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
      (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
      (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`
    ];
    let lastErr = null;
    for (const build of proxies){
      try{
        const res = await fetch(build(yahooUrl), { cache: 'no-store' });
        if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
        const text = await res.text();
        const json = JSON.parse(text);
        if (json && json.chart && json.chart.result && json.chart.result[0]) return json;
        if (json && json.chart && json.chart.error) { lastErr = new Error(json.chart.error.description || 'Yahoo error'); continue; }
        lastErr = new Error('Unexpected response shape');
      } catch(e){ lastErr = e; }
    }
    throw lastErr || new Error('All proxies failed');
  }

  function parseChart(json, interval){
    const result = json.chart.result[0];
    const ts = result.timestamp || [];
    const q = result.indicators.quote[0];
    const out = [];
    for (let i = 0; i < ts.length; i++){
      if (q.open[i] == null || q.close[i] == null) continue;
      out.push({ t: ts[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
    }
    return { candles: out, meta: result.meta, interval };
  }

  function setStatus(msg){ statusEl.textContent = msg || ''; }
  function showError(msg){ errBox.innerHTML = msg; errBox.style.display = 'block'; }
  function hideError(){ errBox.style.display = 'none'; }

  async function loadData(){
    const symbol = inSymbol.value.trim() || '^NSEI';
    const interval = inInterval.value;
    const range = inRange.value;
    hideError();
    loadingBox.style.display = 'flex';
    setStatus('fetching…');
    try{
      const json = await fetchJSON(symbol, interval, range);
      const parsed = parseChart(json, interval);
      if (!parsed.candles.length) throw new Error('No candle data returned for this symbol/interval/range combination.');
      candles = parsed.candles;
      currentMeta = { symbol: parsed.meta.symbol || symbol, interval };
      hoverIndex = -1;
      updateReadout(candles.length - 1);
      draw();
      setStatus(candles.length + ' candles · updated ' + new Date().toLocaleTimeString());
    } catch(e){
      showError(
        'Could not load data (' + (e.message || e) + ').<br>' +
        'Usually a CORS proxy hiccup — click Load to retry, or try a different interval/range.'
      );
      setStatus('failed');
    } finally {
      loadingBox.style.display = 'none';
    }
  }

  function updateReadout(idx){
    if (idx < 0 || idx >= candles.length) return;
    const c = candles[idx];
    const prev = candles[idx - 1];
    const chg = prev ? c.c - prev.c : 0;
    const chgPct = prev ? (chg / prev.c) * 100 : 0;
    const up = chg >= 0;
    document.getElementById('tSym').textContent = currentMeta.symbol;
    document.getElementById('tPrice').textContent = fmtNum(c.c);
    const chgEl = document.getElementById('tChg');
    chgEl.textContent = (up ? '▲ ' : '▼ ') + fmtNum(Math.abs(chg)) + ' (' + Math.abs(chgPct).toFixed(2) + '%)';
    chgEl.className = 'badge ' + (up ? 'up' : 'down');
    document.getElementById('tO').textContent = fmtNum(c.o);
    document.getElementById('tH').textContent = fmtNum(c.h);
    document.getElementById('tL').textContent = fmtNum(c.l);
    document.getElementById('tC').textContent = fmtNum(c.c);
    document.getElementById('tV').textContent = fmtVol(c.v);
    document.getElementById('tTime').textContent = fmtDate(c.t, currentMeta.interval);
  }

  // ---- Canvas rendering ----
  let dpr = window.devicePixelRatio || 1;

  function resizeCanvas(){
    const rect = wrap.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, rect.width * dpr);
    canvas.height = Math.max(1, rect.height * dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    draw();
  }

  const PADDING = { top: 16, right: 58, bottom: 26, left: 8 };
  const VOLUME_H_RATIO = 0.2;

  function draw(){
    const w = canvas.width, h = canvas.height;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,w,h);
    if (!candles.length) return;

    const plotW = w - PADDING.left * dpr - PADDING.right * dpr;
    const plotTop = PADDING.top * dpr;
    const totalPlotH = h - PADDING.top * dpr - PADDING.bottom * dpr;
    const volH = totalPlotH * VOLUME_H_RATIO;
    const priceH = totalPlotH - volH - (10 * dpr);
    const volTop = plotTop + priceH + (10 * dpr);

    const n = candles.length;
    const slot = plotW / n;
    const candleW = Math.max(1, Math.min(slot * 0.7, 14 * dpr));

    let minP = Infinity, maxP = -Infinity, maxV = 0;
    for (const c of candles){
      if (c.l < minP) minP = c.l;
      if (c.h > maxP) maxP = c.h;
      if (c.v > maxV) maxV = c.v;
    }
    const pad = (maxP - minP) * 0.06 || 1;
    minP -= pad; maxP += pad;

    function yPrice(p){ return plotTop + (1 - (p - minP) / (maxP - minP)) * priceH; }
    function yVol(v){ return volTop + volH - (v / (maxV || 1)) * volH; }
    function xCandle(i){ return PADDING.left * dpr + slot * i + slot / 2; }

    // grid + price labels
    ctx.strokeStyle = COLOR.border;
    ctx.fillStyle = COLOR.muted;
    ctx.font = (11*dpr) + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    const gridLines = 5;
    for (let i=0;i<=gridLines;i++){
      const p = minP + (maxP-minP) * (i/gridLines);
      const y = yPrice(p);
      ctx.beginPath();
      ctx.moveTo(PADDING.left*dpr, y);
      ctx.lineTo(PADDING.left*dpr + plotW, y);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillText(fmtNum(p, p < 10 ? 4 : 2), PADDING.left*dpr + plotW + 6*dpr, y);
    }

    // candles
    for (let i=0;i<n;i++){
      const c = candles[i];
      const x = xCandle(i);
      const up = c.c >= c.o;
      ctx.strokeStyle = up ? COLOR.bull : COLOR.bear;
      ctx.fillStyle = up ? COLOR.bull : COLOR.bear;
      ctx.lineWidth = Math.max(1, dpr);
      // wick
      ctx.beginPath();
      ctx.moveTo(x, yPrice(c.h));
      ctx.lineTo(x, yPrice(c.l));
      ctx.stroke();
      // body
      const yO = yPrice(c.o), yC = yPrice(c.c);
      const top = Math.min(yO, yC);
      const bh = Math.max(1, Math.abs(yC - yO));
      ctx.fillRect(x - candleW/2, top, candleW, bh);

      // volume
      ctx.fillStyle = up ? COLOR.bullSoft : COLOR.bearSoft;
      const vTop = yVol(c.v);
      ctx.fillRect(x - candleW/2, vTop, candleW, (volTop + volH) - vTop);
    }

    // time labels (a handful, evenly spaced)
    ctx.fillStyle = COLOR.muted;
    ctx.textAlign = 'center';
    const labelCount = Math.min(6, n);
    for (let k=0;k<labelCount;k++){
      const i = Math.floor(k * (n-1) / Math.max(1,labelCount-1));
      const x = xCandle(i);
      ctx.fillText(fmtDate(candles[i].t, currentMeta.interval).replace(',', ''), x, h - PADDING.bottom*dpr/2);
    }

    // hover crosshair
    if (hoverIndex >= 0 && hoverIndex < n){
      const x = xCandle(hoverIndex);
      ctx.strokeStyle = COLOR.text;
      ctx.globalAlpha = 0.25;
      ctx.setLineDash([4*dpr,3*dpr]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, volTop + volH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // store geometry for hit testing
    draw._geom = { slot, n, left: PADDING.left*dpr };
  }

  function handleMove(evt){
    if (!candles.length || !draw._geom) return;
    const rect = canvas.getBoundingClientRect();
    const xCss = evt.clientX - rect.left;
    const x = xCss * dpr;
    const { slot, n, left } = draw._geom;
    let idx = Math.floor((x - left) / slot);
    idx = Math.max(0, Math.min(n-1, idx));
    if (idx !== hoverIndex){
      hoverIndex = idx;
      updateReadout(idx);
      draw();
    }
    const c = candles[idx];
    tooltip.style.display = 'block';
    tooltip.style.left = Math.min(xCss + 14, rect.width - 150) + 'px';
    tooltip.style.top = '14px';
    tooltip.innerHTML =
      '<div class="row"><b>Time</b> ' + fmtDate(c.t, currentMeta.interval) + '</div>' +
      '<div class="row"><b>O</b> ' + fmtNum(c.o) + '</div>' +
      '<div class="row"><b>H</b> ' + fmtNum(c.h) + '</div>' +
      '<div class="row"><b>L</b> ' + fmtNum(c.l) + '</div>' +
      '<div class="row"><b>C</b> ' + fmtNum(c.c) + '</div>' +
      '<div class="row"><b>Vol</b> ' + fmtVol(c.v) + '</div>';
  }
  function handleLeave(){
    tooltip.style.display = 'none';
    hoverIndex = -1;
    updateReadout(candles.length - 1);
    draw();
  }

  canvas.addEventListener('mousemove', handleMove);
  canvas.addEventListener('mouseleave', handleLeave);
  window.addEventListener('resize', resizeCanvas);
  btnLoad.addEventListener('click', loadData);
  inSymbol.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadData(); });

  new ResizeObserver(resizeCanvas).observe(wrap);

  // initial load
  resizeCanvas();
  loadData();
})();
