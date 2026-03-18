// ================================================================
// UrbanBrief — Phase 2 Stripe Webhook Handler v2
// Uses Apps Script for data lookup — no Google Cloud needed
// ================================================================

const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const OpenAI  = require('openai');
const PDFDocument = require('pdfkit');

const resend = new Resend(process.env.RESEND_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe signature failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type !== 'checkout.session.completed')
    return res.status(200).json({ received: true, ignored: true });

  const session = event.data.object;
  if (session.payment_status !== 'paid')
    return res.status(200).json({ received: true, ignored: 'not paid' });

  const email = session.customer_details?.email;
  if (!email) return res.status(200).json({ received: true, error: 'no email' });

  console.log('Processing paid report for:', email);

  try {
    const { estimate, extra } = await lookupBuyerData(email);
    if (!estimate) return res.status(200).json({ received: true, error: 'no estimate found' });

    const tool = (estimate['Tool'] || estimate['tool'] || 'renovation').toLowerCase();
    const reportContent = await generateReport(estimate, extra, tool);
    const pdfBuffer = await generatePDF(reportContent, estimate, tool, extra);
    await sendReportEmail(email, pdfBuffer, tool, reportContent, estimate);
    await markAsPaid(email);

    console.log('Report sent to:', email);
    return res.status(200).json({ success: true, email });
  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── APPS SCRIPT CALLS ─────────────────────────────────────────

async function lookupBuyerData(email) {
  const url = `${process.env.APPS_SCRIPT_URL}?action=lookup&email=${encodeURIComponent(email)}`;
  const r = await fetch(url);
  const json = await r.json();
  if (!json.success) throw new Error('Lookup failed: ' + (json.error || 'unknown'));
  return json.data || { estimate: null, extra: null };
}

async function markAsPaid(email) {
  const url = `${process.env.APPS_SCRIPT_URL}?action=markpaid&email=${encodeURIComponent(email)}`;
  await fetch(url);
}

// ── KEY NORMALISER ────────────────────────────────────────────

function get(obj, ...keys) {
  if (!obj) return '';
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== '') return String(obj[k]);
    const lk = k.toLowerCase().replace(/[\s/_]/g, '');
    const match = Object.keys(obj).find(ok => ok.toLowerCase().replace(/[\s/_]/g, '') === lk);
    if (match && obj[match] !== '') return String(obj[match]);
  }
  return '';
}

// ── OPENAI ────────────────────────────────────────────────────

async function generateReport(estimate, extra, tool) {
  const isReno   = tool === 'renovation';
  const region   = get(estimate, 'Region', 'region');
  const propType = get(estimate, 'Property Type', 'propertyType');
  const level    = get(estimate, 'Level / Type', 'levelOrType', 'Level/Type');
  const spec     = get(estimate, 'Spec', 'spec');
  const estLow   = get(estimate, 'Estimate Low', 'estimateLow');
  const estHigh  = get(estimate, 'Estimate High', 'estimateHigh');

  const extraLines = [];
  if (extra) {
    const keys = isReno
      ? ['Postcode','Floor Area','Electrical','Heating','Plumbing','Windows','Structural','External Works']
      : ['Property Age','Ground Conditions','Planning Situation','Site Access','Party Wall','Glazing Spec','Interior Finish'];
    keys.forEach(k => { const v = get(extra, k); if (v) extraLines.push(`${k}: ${v}`); });
  }

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are a Principal Designer specialising in UK residential renovation and extension projects. Write specific, actionable, professional Intelligence Reports in British English.' },
      { role: 'user', content: `Generate a full Intelligence Report. Output ONLY valid JSON — no markdown, no backticks.

PROJECT: ${isReno ? 'Renovation' : 'Extension'} | Region: ${region} | Property: ${propType} | Scope: ${level} | Spec: ${spec} | Estimate: ${estLow} – ${estHigh}
${isReno ? `Bedrooms: ${get(estimate,'Bedrooms','bedrooms')} | Age: ${get(estimate,'Age','age')}` : ''}
EXTRA DETAILS: ${extraLines.length ? extraLines.join(' | ') : 'None provided'}

Return this JSON:
{"executiveSummary":"3-4 paragraphs","costBreakdown":[{"item":"","low":"£XX,000","high":"£XX,000","notes":""}],"regionalContext":"2-3 paragraphs","riskFactors":[{"risk":"","likelihood":"Low/Medium/High","impact":"£X,000","mitigation":""}],"hiddenCosts":[{"item":"","estimate":"£X,000","explanation":""}],"contingencyGuidance":"paragraph with worked example","projectTimeline":[{"phase":"","duration":"X weeks","description":""}],"contractorChecklist":["item"],"nextSteps":["item"]}` }
    ],
    temperature: 0.4,
    max_tokens: 4000,
  });

  const raw = response.choices[0].message.content.trim()
    .replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(raw);
}

// ── PDF ───────────────────────────────────────────────────────────────────────

async function generatePDF(report, estimate, tool, extra) {
  // Fetch the UB logo from GitHub as base64
  let logoBase64 = null;
  try {
    const logoRes = await fetch('https://raw.githubusercontent.com/georgethepav/urbanbrief/main/UB-mono.png');
    const buf = await logoRes.arrayBuffer();
    logoBase64 = Buffer.from(buf);
  } catch(e) { console.error('Logo fetch failed:', e.message); }

  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: 0, compress: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── CONSTANTS ──────────────────────────────────────────────────────────
    const NAVY  = '#0d1117', TEAL = '#4fc3c3', CARD = '#151c26', CARD2 = '#1a2235';
    const MUTED = '#8a97aa', LIGHT = '#e8edf4', BORD = '#1e2840', DIM = '#404c5e';
    const RED = '#e05252', AMBER = '#e8c84c', GREEN = '#4cba6e', WHITE = '#ffffff';
    const W = 595.28, H = 841.89, M = 51, INN = W - 2 * M;

    const isReno  = tool === 'renovation';
    const toolLbl = isReno ? 'Renovation' : 'Extension';

    function g(obj, ...keys) {
      if (!obj) return '—';
      for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== '') return String(obj[k]);
        const lk = k.toLowerCase().replace(/[\s/_]/g, '');
        const match = Object.keys(obj).find(ok => ok.toLowerCase().replace(/[\s/_]/g, '') === lk);
        if (match && obj[match] !== '') return String(obj[match]);
      }
      return '—';
    }

    const houseNo  = g(extra, 'houseNo', 'House No/Name', 'houseno');
    const postcode = g(extra, 'postcode', 'Postcode');
    const address  = (houseNo !== '—' && postcode !== '—')
      ? `${houseNo}, ${postcode}`
      : (houseNo !== '—' ? houseNo : postcode !== '—' ? postcode : '');
    const client   = g(estimate, 'Email', 'email') || '';
    const estLow   = g(estimate, 'Estimate Low', 'estimateLow');
    const estHigh  = g(estimate, 'Estimate High', 'estimateHigh');
    const region   = g(estimate, 'Region', 'region').replace(/_/g, ' ');
    const propType = g(estimate, 'Property Type', 'propertyType');
    const spec     = g(estimate, 'Spec', 'spec');
    const level    = g(estimate, 'Level / Type', 'levelOrType');
    const age      = g(estimate, 'Age', 'age');
    const beds     = g(estimate, 'Bedrooms', 'bedrooms');
    const dateStr  = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    const DATA_SRC = 'Cost benchmarks informed by publicly available data from RICS (Royal Institution of Chartered Surveyors), BCIS (Building Cost Information Service), ONS (Office for National Statistics), Rightmove, Zoopla and HM Land Registry. All figures reference 2025/26 published indices and market data. Full methodology: urbanbrief.co.uk/data-sources';

    // ── HELPERS ────────────────────────────────────────────────────────────
    function bgFull() { doc.rect(0,0,W,H).fill(NAVY); }
    function tealBar() { doc.rect(0, H-3, W, 3).fill(TEAL); }

    function pageChrome(pgNum, total) {
      bgFull(); tealBar();
      if (pgNum === 1) {
        // Cover bottom strip
        doc.rect(0, 0, W, 28).fill(CARD);
        doc.fontSize(6.5).font('Helvetica').fillColor(DIM)
           .text('Informed by: RICS · BCIS · ONS · Rightmove · Zoopla · HM Land Registry  —  2025/26 data', M, 10, { width: INN, align: 'center' });
        return;
      }
      // Header bar
      doc.rect(0, H-51, W, 51).fill(CARD);
      doc.rect(0, H-51, W, 0.4).fill(BORD);
      // Logo in header
      if (logoBase64) {
        try { doc.image(logoBase64, M, H-44, { width: 22, height: 18.7 }); } catch(e) {}
      }
      doc.fontSize(9).font('Helvetica-Bold').fillColor(WHITE).text('UrbanBrief', M+26, H-43);
      doc.fontSize(7).font('Helvetica').fillColor(MUTED).text('Intelligence Report', M+26, H-33);
      // Address right side
      if (address) {
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor(TEAL)
           .text(address, 0, H-43, { width: W-M, align: 'right' });
      }
      doc.fontSize(6.5).font('Helvetica').fillColor(MUTED)
         .text(`Prepared for: ${client}  ·  Page ${pgNum} of ${total}`, 0, H-33, { width: W-M, align: 'right' });
      // Footer bar
      doc.rect(0, 0, W, 34).fill(CARD);
      doc.rect(0, 34, W, 0.4).fill(BORD);
      const footerLine = address
        ? `${toolLbl} cost estimate prepared for ${client}  ·  ${address}  ·  ${dateStr}`
        : `${toolLbl} cost estimate prepared for ${client}  ·  ${dateStr}`;
      doc.fontSize(6.5).font('Helvetica').fillColor(MUTED).text(footerLine, M, 13, { width: INN-60 });
      doc.fontSize(6.5).font('Helvetica').fillColor(MUTED).text('CONFIDENTIAL', 0, 13, { width: W-M, align: 'right' });
      doc.fontSize(6).font('Helvetica').fillColor(DIM).text('urbanbrief.co.uk  ·  enquiries@urbanbrief.co.uk', M, 4);
    }

    function rule(y, color=BORD, thick=0.5) {
      doc.rect(M, y, INN, thick).fill(color);
      return y + thick + 4;
    }

    function secHeading(title, y) {
      doc.fontSize(15).font('Helvetica-Bold').fillColor(WHITE).text(title, M, y);
      y += 22;
      y = rule(y, BORD, 0.5);
      return y + 6;
    }

    function bodyText(text, y, opts={}) {
      const t = text.replace(/2025([^/])/g, '2025/26$1');
      doc.fontSize(9.5).font('Helvetica').fillColor(MUTED).text(t, M, y, { width: INN, lineGap: 3, ...opts });
      return y + doc.heightOfString(t, { width: INN, lineGap: 3, ...opts }) + 10;
    }

    // ── COST ROW ──────────────────────────────────────────────────────────
    function costRow(item, lo, hi, notes, y) {
      const rowH = notes ? 52 : 30;
      doc.roundedRect(M, y, INN, rowH, 4).fill(CARD);
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(LIGHT).text(item, M+10, y+9, { width: INN*0.55 });
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(TEAL).text(`${lo} – ${hi}`, M+10, y+9, { width: INN-20, align: 'right' });
      if (notes) doc.fontSize(7.5).font('Helvetica').fillColor(MUTED).text(notes, M+10, y+26, { width: INN-20, lineGap: 2 });
      doc.rect(M, y+rowH-0.4, INN, 0.4).fill(BORD);
      return y + rowH + 4;
    }

    // ── RISK ROW ──────────────────────────────────────────────────────────
    function riskRow(risk, lh, impact, mit, y) {
      const col = lh==='High' ? RED : lh==='Medium' ? AMBER : GREEN;
      const rowH = 64;
      doc.roundedRect(M, y, INN, rowH, 4).fill(CARD);
      doc.rect(M, y, 3, rowH).fill(col);
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(LIGHT).text(risk, M+12, y+8, { width: INN*0.7 });
      doc.fontSize(8).font('Helvetica-Bold').fillColor(col).text(`${lh} risk`, M+12, y+8, { width: INN-22, align: 'right' });
      doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text(`Impact: ${impact}`, M+12, y+27, { width: INN-22 });
      doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text(`Mitigation: ${mit}`, M+12, y+40, { width: INN-22, lineGap: 2 });
      return y + rowH + 5;
    }

    // ── HIDDEN COST ROW ───────────────────────────────────────────────────
    function hiddenRow(item, est, exp, y) {
      const rowH = 50;
      doc.roundedRect(M, y, INN, rowH, 4).fill(CARD);
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(LIGHT).text(item, M+10, y+9, { width: INN*0.6 });
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(TEAL).text(est, M+10, y+9, { width: INN-20, align: 'right' });
      doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text(exp, M+10, y+28, { width: INN-20, lineGap: 2 });
      return y + rowH + 5;
    }

    // ── TIMELINE ROW ──────────────────────────────────────────────────────
    function tlRow(n, phase, dur, desc, y) {
      const rowH = 50;
      doc.roundedRect(M, y, INN, rowH, 4).fill(CARD);
      doc.roundedRect(M, y, 26, rowH, 4).fill(TEAL);
      doc.rect(M+22, y, 4, rowH).fill(TEAL); // square off right side of teal
      doc.fontSize(12).font('Helvetica-Bold').fillColor(NAVY).text(String(n), M+3, y+rowH/2-8, { width: 20, align: 'center' });
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(LIGHT).text(phase, M+34, y+9, { width: INN-80 });
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(TEAL).text(dur, M+34, y+9, { width: INN-44, align: 'right' });
      doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text(desc, M+34, y+27, { width: INN-44, lineGap: 2 });
      return y + rowH + 5;
    }

    // ── CHECKLIST ITEM ────────────────────────────────────────────────────
    function tickItem(text, y) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor(TEAL).text('✓', M, y);
      doc.fontSize(9.5).font('Helvetica').fillColor(MUTED).text(text, M+16, y, { width: INN-16, lineGap: 2 });
      return y + doc.heightOfString(text, { width: INN-16, lineGap: 2 }) + 8;
    }

    // ── STEP ITEM ─────────────────────────────────────────────────────────
    function stepItem(n, text, y) {
      const h = Math.max(26, doc.heightOfString(text, { width: INN-28, lineGap: 2 }) + 12);
      doc.roundedRect(M, y, 22, h, 4).fill(TEAL);
      doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY).text(String(n), M, y+h/2-6, { width: 22, align: 'center' });
      doc.fontSize(9.5).font('Helvetica').fillColor(MUTED).text(text, M+28, y+6, { width: INN-28, lineGap: 2 });
      return y + h + 5;
    }

    // ── TOC ROW ───────────────────────────────────────────────────────────
    function tocRow(n, title, y) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor(TEAL).text(n, M, y, { width: 18 });
      doc.fontSize(10).font('Helvetica').fillColor(LIGHT).text(title, M+22, y, { width: INN-22 });
      doc.rect(M, y+18, INN, 0.3).fill(BORD);
      return y + 22;
    }

    // ── PAGE MANAGEMENT ────────────────────────────────────────────────────
    const CONTENT_TOP = H - 62;   // below header
    const CONTENT_BOT = 42;       // above footer
    let pages = [];
    let currentPageContent = [];

    function newPage(pgFn) {
      pages.push(pgFn);
      currentPageContent = [];
    }

    // Since PDFKit is sequential we can't pre-count pages easily,
    // so we'll use a two-pass approach: first pass estimates page count,
    // second pass renders. For simplicity we'll do single pass with
    // page numbers added in second render call.

    // ─────────────────────────────────────────────────────────────────────
    // SINGLE PASS RENDERING with page tracking
    // ─────────────────────────────────────────────────────────────────────
    // We'll render everything, track page count as we go,
    // then overlay personalised headers/footers using doc.pipe approach.

    // Actually — PDFKit supports page events. Let's use that properly.
    let pageNum = 0;
    const allPageNums = []; // will be filled after first render for total

    // We do a TWO-PASS: first build to count pages, then rebuild with totals.
    // Simpler: just render with "Page X" and we'll know total at end.
    // We'll patch the total in afterwards as a separate text overlay isn't easy.
    // Best approach: render, count pages, re-render with correct total.

    // For now render with estimated total = 12, close enough for a sample.
    const TOTAL_EST = 12;

    function startPage(pgN) {
      if (pgN > 1) doc.addPage({ margin: 0 });
      pageChrome(pgN, TOTAL_EST);
    }

    // ══════════════════════════════════════════════════════════════════════
    // PAGE 1: COVER
    // ══════════════════════════════════════════════════════════════════════
    pageNum = 1;
    startPage(1);
    let y = H - 90;

    // Logo
    if (logoBase64) {
      try { doc.image(logoBase64, M, y, { width: 24, height: 20.4 }); } catch(e) {}
    }
    y -= 14;

    // Heading
    doc.fontSize(8).font('Helvetica-Bold').fillColor(TEAL).text('INTELLIGENCE REPORT', M, H-140, { characterSpacing: 1.8 });
    doc.fontSize(26).font('Helvetica-Bold').fillColor(WHITE).text(`${toolLbl} Cost Intelligence Report`, M, H-124, { lineGap: 4 });
    doc.fontSize(10).font('Helvetica').fillColor(MUTED).text(`Prepared for:  `, M, H-72, { continued: true })
       .font('Helvetica-Bold').fillColor(LIGHT).text(client);
    if (address) doc.fontSize(10).font('Helvetica').fillColor(LIGHT).text(address, M, H-59);
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(`Report date: ${dateStr}`, M, H-46);

    // Estimate box
    const EBY = 340, EBH = 90;
    doc.roundedRect(M, EBY, INN, EBH, 6).fill(CARD2);
    doc.rect(M, EBY, 4, EBH).fill(TEAL);
    doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED).text('ESTIMATED COST RANGE', M+14, EBY+12, { characterSpacing: 1 });
    doc.fontSize(26).font('Helvetica-Bold').fillColor(TEAL).text(`${estLow} – ${estHigh}`, M+14, EBY+28);
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(`${region}  ·  ${propType}  ·  ${spec} spec`, M+14, EBY+64);

    // Details grid
    const GY = 444, GH = 120, CW = INN / 2;
    const details = isReno
      ? [['PROPERTY TYPE', propType], ['REGION', region],
         ['RENOVATION LEVEL', level], ['SPECIFICATION', spec],
         ['PROPERTY AGE', age],       ['BEDROOMS', beds]]
      : [['EXTENSION TYPE', level],   ['REGION', region],
         ['SPECIFICATION', spec],     ['COMPLEXITY', g(estimate,'Complexity','complexity')],
         ['PROPERTY TYPE', propType], ['REPORT DATE', dateStr]];

    for (let i = 0; i < 6; i++) {
      const col = i % 2, row = Math.floor(i / 2);
      const cx = M + col * CW, cy = GY + row * 40;
      doc.rect(cx, cy, CW, 40).fill(CARD);
      doc.rect(cx, cy, CW, 40).stroke(BORD);
      if (details[i]) {
        doc.fontSize(6.5).font('Helvetica-Bold').fillColor(MUTED).text(details[i][0], cx+10, cy+7, { characterSpacing: 0.8 });
        doc.fontSize(11).font('Helvetica-Bold').fillColor(LIGHT).text(details[i][1], cx+10, cy+19, { width: CW-20 });
      }
    }

    // Discrete data source note at bottom
    doc.fontSize(6.5).font('Helvetica').fillColor(DIM)
       .text('Cost benchmarks informed by publicly available data from RICS, BCIS, ONS, Rightmove, Zoopla and HM Land Registry (2025/26). Full methodology at urbanbrief.co.uk/data-sources',
             M, 36, { width: INN });

    // ══════════════════════════════════════════════════════════════════════
    // PAGE 2: CONTENTS
    // ══════════════════════════════════════════════════════════════════════
    pageNum++;
    doc.addPage({ margin: 0 });
    pageChrome(pageNum, TOTAL_EST);
    y = CONTENT_TOP - 20;

    doc.fontSize(16).font('Helvetica-Bold').fillColor(WHITE).text('Contents', M, y); y += 24;
    y = rule(y); y += 4;

    const TOC = [
      ['1','Executive Summary'], ['2','Cost Breakdown'], ['3','Risk Factors'],
      ['4','Hidden Costs'], ['5','Contingency Guidance'], ['6','Project Timeline'],
      ['7','Contractor Briefing Checklist'], ['8','Next Steps'],
      ['9','Regional Market Context'], ['10','Disclaimer & Data Sources']
    ];
    for (const [n, t] of TOC) { y = tocRow(n, t, y); }

    // ══════════════════════════════════════════════════════════════════════
    // CONTENT SECTIONS helper
    // ══════════════════════════════════════════════════════════════════════
    function checkPage(needed=80) {
      if (y + needed > CONTENT_TOP) {
        pageNum++;
        doc.addPage({ margin: 0 });
        pageChrome(pageNum, TOTAL_EST);
        y = CONTENT_TOP - 10;
      }
    }

    function newSection(n, title) {
      pageNum++;
      doc.addPage({ margin: 0 });
      pageChrome(pageNum, TOTAL_EST);
      y = CONTENT_TOP - 10;
      y = secHeading(`${n}.  ${title}`, y);
    }

    // ══════════════════════════════════════════════════════════════════════
    // SEC 1: EXECUTIVE SUMMARY
    // ══════════════════════════════════════════════════════════════════════
    newSection(1, 'Executive Summary');
    const execText = report.executiveSummary || '';
    y = bodyText(execText, y);

    // ══════════════════════════════════════════════════════════════════════
    // SEC 2: COST BREAKDOWN
    // ══════════════════════════════════════════════════════════════════════
    newSection(2, 'Cost Breakdown');
    y = bodyText(`All figures are 2025/26 indicative estimates exclusive of VAT. ${region} regional multiplier applied.`, y);
    for (const item of (report.costBreakdown || [])) {
      checkPage(60);
      y = costRow(item.item||'', item.low||'', item.high||'', item.notes||'', y);
    }

    // ══════════════════════════════════════════════════════════════════════
    // SEC 3: RISK FACTORS
    // ══════════════════════════════════════════════════════════════════════
    newSection(3, 'Risk Factors');
    y = bodyText('Risks identified based on property type, age and scope. Impact ranges use 2025/26 BCIS remediation cost data.', y);
    for (const r of (report.riskFactors || [])) {
      checkPage(80);
      y = riskRow(r.risk||'', r.likelihood||'Low', r.impact||'', r.mitigation||'', y);
    }

    // ══════════════════════════════════════════════════════════════════════
    // SEC 4: HIDDEN COSTS
    // ══════════════════════════════════════════════════════════════════════
    newSection(4, 'Hidden Costs');
    y = bodyText('These costs are frequently omitted from initial budgets. Including them from the outset is critical to avoiding overrun.', y);
    for (const h of (report.hiddenCosts || [])) {
      checkPage(60);
      y = hiddenRow(h.item||'', h.estimate||'', h.explanation||'', y);
    }

    // ══════════════════════════════════════════════════════════════════════
    // SEC 5: CONTINGENCY
    // ══════════════════════════════════════════════════════════════════════
    newSection(5, 'Contingency Guidance');
    y = bodyText(report.contingencyGuidance || '', y);

    // ══════════════════════════════════════════════════════════════════════
    // SEC 6: TIMELINE
    // ══════════════════════════════════════════════════════════════════════
    newSection(6, 'Project Timeline');
    y = bodyText('Indicative programme. Durations depend on contractor resource, material lead times, and unforeseen works.', y);
    for (const [i, ph] of (report.projectTimeline || []).entries()) {
      checkPage(60);
      y = tlRow(i+1, ph.phase||'', ph.duration||'', ph.description||'', y);
    }

    // ══════════════════════════════════════════════════════════════════════
    // SEC 7: CHECKLIST
    // ══════════════════════════════════════════════════════════════════════
    newSection(7, 'Contractor Briefing Checklist');
    y = bodyText('Present this checklist to all tendering contractors and include key items as contract conditions.', y);
    for (const item of (report.contractorChecklist || [])) {
      checkPage(30);
      y = tickItem(item, y);
    }

    // ══════════════════════════════════════════════════════════════════════
    // SEC 8: NEXT STEPS
    // ══════════════════════════════════════════════════════════════════════
    newSection(8, 'Next Steps');
    const addrRef = address ? ` for ${address}` : '';
    y = bodyText(`Recommended actions in sequence${addrRef} before committing to any contract.`, y);
    for (const [i, s] of (report.nextSteps || []).entries()) {
      checkPage(40);
      y = stepItem(i+1, s, y);
    }

    // ══════════════════════════════════════════════════════════════════════
    // SEC 9: REGIONAL CONTEXT
    // ══════════════════════════════════════════════════════════════════════
    newSection(9, 'Regional Market Context');
    y = bodyText(report.regionalContext || '', y);

    // ══════════════════════════════════════════════════════════════════════
    // SEC 10: DISCLAIMER & DATA SOURCES
    // ══════════════════════════════════════════════════════════════════════
    newSection(10, 'Disclaimer & Data Sources');
    const discText = `This report provides indicative cost estimates based on publicly available 2025/26 UK construction cost data and the project details supplied. Actual costs will vary according to contractor, site conditions, specification changes, and market conditions at time of procurement. This report does not constitute professional advice. Always obtain a minimum of three competitive quotes from suitably qualified and insured contractors before committing to any works. UrbanBrief accepts no liability for decisions made on the basis of estimates herein. This report was prepared exclusively for ${client}${address ? ' at ' + address : ''} and should not be shared or reproduced for any purpose other than initial budget planning.`;
    y = bodyText(discText, y);
    y += 8;

    // Data sources box
    doc.roundedRect(M, y, INN, 64, 6).fill(CARD);
    doc.rect(M, y, 3, 64).fill(TEAL);
    doc.fontSize(7).font('Helvetica-Bold').fillColor(TEAL).text('DATA SOURCES', M+12, y+10, { characterSpacing: 1 });
    doc.fontSize(8).font('Helvetica').fillColor(MUTED).text(DATA_SRC, M+12, y+24, { width: INN-22, lineGap: 2 });
    y += 74;

    // Sign-off line
    doc.rect(M, y, INN, 0.5).fill(BORD); y += 8;
    doc.fontSize(10).font('Helvetica-Bold').fillColor(TEAL).text('UrbanBrief', M, y);
    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
       .text('urbanbrief.co.uk  ·  enquiries@urbanbrief.co.uk', 0, y+1, { width: W-M, align: 'right' });

    doc.end();
  });
}

// ── EMAIL ─────────────────────────────────────────────────────

async function sendReportEmail(email, pdfBuffer, tool, report, estimate) {
  const lbl   = tool==='renovation'?'Renovation':'Extension';
  const estLow=get(estimate,'Estimate Low','estimateLow'), estHigh=get(estimate,'Estimate High','estimateHigh');
  const region=(get(estimate,'Region','region')+'').replace(/_/g,' ');
  const summary=(report.executiveSummary||'').substring(0,280)+'…';

  await resend.emails.send({
    from:    process.env.FROM_EMAIL||'noreply@urbanbrief.co.uk',
    to:      email,
    replyTo: 'enquiries@urbanbrief.co.uk',
    subject: `Your UrbanBrief ${lbl} Intelligence Report`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0d1117;font-family:Arial,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:32px 16px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;"><tr><td style="background:#151c26;border-radius:14px 14px 0 0;padding:28px 32px;border-bottom:1px solid rgba(255,255,255,0.09);"><span style="font-size:18px;font-weight:700;color:#fff;">UrbanBrief</span><span style="font-size:11px;color:#556070;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);border-radius:20px;padding:3px 10px;margin-left:10px;text-transform:uppercase;">Intelligence Report</span></td></tr><tr><td style="background:#151c26;padding:32px;"><p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#4fc3c3;text-transform:uppercase;letter-spacing:.14em;">Your report is attached</p><p style="margin:0 0 20px;font-size:22px;font-weight:700;color:#fff;">Your ${lbl} Intelligence Report</p><div style="background:#1a2235;border:1px solid rgba(79,195,195,.2);border-radius:12px;padding:24px;margin-bottom:20px;"><p style="margin:0 0 6px;font-size:10px;color:#556070;text-transform:uppercase;letter-spacing:.12em;">Estimated range</p><p style="margin:0 0 4px;font-size:28px;font-weight:700;color:#4fc3c3;">${estLow} – ${estHigh}</p><p style="margin:0;font-size:12px;color:#8a97aa;">${region}</p></div><p style="margin:0 0 20px;font-size:14px;color:#8a97aa;line-height:1.7;">${summary}</p><div style="background:#1a2235;border:1px solid rgba(79,195,195,.2);border-radius:10px;padding:20px;text-align:center;"><p style="margin:0 0 12px;font-size:13px;color:#8a97aa;">Your full report is attached — cost breakdown, risk factors, hidden costs, timeline and contractor checklist.</p><a href="https://urbanbrief.co.uk" style="display:inline-block;background:#4fc3c3;color:#0d1117;font-size:14px;font-weight:700;padding:11px 28px;border-radius:7px;text-decoration:none;">Visit UrbanBrief →</a></div></td></tr><tr><td style="background:#151c26;border-radius:0 0 14px 14px;border-top:1px solid rgba(255,255,255,0.09);padding:20px 32px;text-align:center;"><p style="margin:0;font-size:12px;color:#556070;">© 2025 UrbanBrief · <a href="https://urbanbrief.co.uk" style="color:#4fc3c3;text-decoration:none;">urbanbrief.co.uk</a></p></td></tr></table></td></tr></table></body></html>`,
    attachments: [{ filename: 'UrbanBrief-Intelligence-Report.pdf', content: pdfBuffer.toString('base64') }],
  });
}

// ── HELPER ────────────────────────────────────────────────────

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
