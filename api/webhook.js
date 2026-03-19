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
  // Idempotency — prevent double-processing same payment
  const piId = session.payment_intent || session.id;
  if (global._processed && global._processed.has(piId)) {
    console.log('Duplicate webhook skipped:', piId);
    return res.status(200).json({ received: true, skipped: 'duplicate' });
  }
  if (!global._processed) global._processed = new Set();
  global._processed.add(piId);

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
      ? ['House No/Name','Postcode','Electrical','Heating','Plumbing','Windows','Structural','External Works']
      : ['Property Age','Ground Conditions','Planning Situation','Site Access','Party Wall','Glazing Spec','Kitchen','Bathrooms','Interior Finish'];
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


// ── PDF ────────────────────────────────────────────────────────────────────────

async function generatePDF(report, estimate, tool, extra) {
  let logoBase64 = null;
  try {
    const r = await fetch('https://raw.githubusercontent.com/georgethepav/urbanbrief/main/UB-mono.png');
    logoBase64 = Buffer.from(await r.arrayBuffer());
  } catch(e) { console.error('Logo fetch failed:', e.message); }

  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: 0, compress: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── COLOURS ──────────────────────────────────────────────────────────
    const NAVY  = '#0d1117', TEAL = '#4fc3c3', CARD = '#151c26', CARD2 = '#1a2235';
    const MUTED = '#8a97aa', LIGHT = '#e8edf4', BORD = '#1e2840', DIM = '#404c5e';
    const RED = '#e05252', AMBER = '#e8c84c', GREEN = '#4cba6e', WHITE = '#ffffff';
    const W = 595.28, H = 841.89, M = 51, INN = W - 2*M;

    const isReno  = tool === 'renovation';
    const toolLbl = isReno ? 'Renovation' : 'Extension';

    function gv(obj, ...keys) {
      if (!obj) return '—';
      for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== '') return String(obj[k]);
        const lk = k.toLowerCase().replace(/[\s/_]/g, '');
        const match = Object.keys(obj).find(ok => ok.toLowerCase().replace(/[\s/_]/g,'')===lk);
        if (match && obj[match] !== '') return String(obj[match]);
      }
      return '—';
    }

    const houseNo  = gv(extra, 'houseNo', 'House No/Name', 'houseno');
    const postcode = gv(extra, 'postcode', 'Postcode');
    const address  = [houseNo!=='—'?houseNo:null, postcode!=='—'?postcode:null].filter(Boolean).join(', ');
    const client   = gv(estimate, 'Email', 'email');
    const estLow   = gv(estimate, 'Estimate Low', 'estimateLow');
    const estHigh  = gv(estimate, 'Estimate High', 'estimateHigh');
    const region   = gv(estimate, 'Region', 'region').replace(/_/g,' ');
    const propType = gv(estimate, 'Property Type', 'propertyType');
    const spec     = gv(estimate, 'Spec', 'spec');
    const level    = gv(estimate, 'Level / Type', 'levelOrType', 'Level/Type');
    const age      = gv(estimate, 'Age', 'age');
    const beds     = gv(estimate, 'Bedrooms', 'bedrooms');
    const dateStr  = new Date().toLocaleDateString('en-GB', { month:'long', year:'numeric' });

    const fmtEst = v => v && v!=='—' ? (v.startsWith('£')?v:'£'+v) : '—';
    const lo = fmtEst(estLow), hi = fmtEst(estHigh);

    // ── PAGE HELPERS ──────────────────────────────────────────────────────
    let pageNum = 0;
    const TOTAL = 12; // estimated

    function newPage() {
      pageNum++;
      if (pageNum > 1) doc.addPage({ margin: 0 });
      // Navy background
      doc.rect(0, 0, W, H).fill(NAVY);
      // Top teal strip
      doc.rect(0, 0, W, 3).fill(TEAL);

      if (pageNum === 1) {
        // Cover bottom strip
        doc.rect(0, H-28, W, 28).fill(CARD);
        doc.rect(0, H-28, W, 0.4).fill(BORD);
        doc.fontSize(6.5).font('Helvetica').fillColor(DIM)
           .text('Informed by: RICS · BCIS · ONS · Rightmove · Zoopla · HM Land Registry — 2025/26 data',
                 M, H-17, { width: INN, align: 'center' });
        return;
      }

      // Header bar (pages 2+)
      doc.rect(0, 3, W, 48).fill(CARD);
      doc.rect(0, 51, W, 0.4).fill(BORD);
      if (logoBase64) {
        try { doc.image(logoBase64, M, 10, { width: 22, height: 18.7 }); } catch(e) {}
      }
      doc.fontSize(9).font('Helvetica-Bold').fillColor(WHITE).text('UrbanBrief', M+26, 12);
      doc.fontSize(7).font('Helvetica').fillColor(MUTED).text('Intelligence Report', M+26, 24);
      if (address) {
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor(TEAL)
           .text(address, M, 12, { width: INN, align: 'right' });
      }
      doc.fontSize(6.5).font('Helvetica').fillColor(MUTED)
         .text(`Prepared for: ${client}  ·  Page ${pageNum} of ${TOTAL}`, M, 24, { width: INN, align: 'right' });

      // Footer bar
      doc.rect(0, H-34, W, 34).fill(CARD);
      doc.rect(0, H-34, W, 0.4).fill(BORD);
      const footLine = address
        ? `${toolLbl} cost estimate prepared for ${client}  ·  ${address}  ·  ${dateStr}`
        : `${toolLbl} cost estimate prepared for ${client}  ·  ${dateStr}`;
      doc.fontSize(6.5).font('Helvetica').fillColor(MUTED)
         .text(footLine, M, H-22, { width: INN-60 });
      doc.fontSize(6.5).font('Helvetica').fillColor(MUTED)
         .text('CONFIDENTIAL', M, H-22, { width: INN, align: 'right' });
      doc.fontSize(6).font('Helvetica').fillColor(DIM)
         .text('urbanbrief.co.uk  ·  enquiries@urbanbrief.co.uk', M, H-12);
    }

    const CONTENT_TOP = 62;  // below header
    const CONTENT_BOT = 44;  // above footer
    const MAX_Y = H - CONTENT_BOT;
    let y = CONTENT_TOP;

    function checkY(needed = 60) {
      if (y + needed > MAX_Y) { newSec(null, null); }
    }

    function newSec(num, title) {
      newPage();
      y = CONTENT_TOP + 8;
      if (num && title) {
        doc.fontSize(15).font('Helvetica-Bold').fillColor(WHITE).text(`${num}.  ${title}`, M, y);
        y += 22;
        doc.rect(M, y, INN, 0.5).fill(BORD);
        y += 8;
      }
    }

    function bodyText(text) {
      const t = (text||'').replace(/(\b2025\b)(?!\/)/g, '2025/26');
      const h = doc.heightOfString(t, { width: INN, lineGap: 3 });
      checkY(h + 10);
      doc.fontSize(9.5).font('Helvetica').fillColor(MUTED).text(t, M, y, { width: INN, lineGap: 3 });
      y += h + 10;
    }

    function rule() {
      doc.rect(M, y, INN, 0.5).fill(BORD);
      y += 6;
    }

    // ── COST ROW ─────────────────────────────────────────────────────────
    function costRow(item, lo, hi, notes) {
      const noteH = notes ? doc.heightOfString(notes, { width: INN-20, lineGap: 2 }) + 6 : 0;
      const rowH = 32 + noteH;
      checkY(rowH + 5);
      doc.roundedRect(M, y, INN, rowH, 4).fill(CARD);
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(LIGHT).text(item, M+10, y+10, { width: INN*0.55 });
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(TEAL)
         .text(`${lo} – ${hi}`, M+10, y+10, { width: INN-20, align: 'right' });
      if (notes) {
        doc.fontSize(7.5).font('Helvetica').fillColor(MUTED)
           .text(notes, M+10, y+28, { width: INN-20, lineGap: 2 });
      }
      doc.rect(M, y+rowH-0.4, INN, 0.4).fill(BORD);
      y += rowH + 5;
    }

    // ── RISK ROW ─────────────────────────────────────────────────────────
    function riskRow(risk, lh, impact, mit) {
      const col = lh==='High' ? RED : lh==='Medium' ? AMBER : GREEN;
      const rowH = 70;
      checkY(rowH + 5);
      doc.roundedRect(M, y, INN, rowH, 4).fill(CARD);
      doc.rect(M, y, 3, rowH).fill(col);
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(LIGHT).text(risk, M+12, y+10, { width: INN*0.68 });
      doc.fontSize(8).font('Helvetica-Bold').fillColor(col).text(`${lh} risk`, M+12, y+10, { width: INN-22, align: 'right' });
      doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text(`Impact: ${impact}`, M+12, y+28, { width: INN-22 });
      doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text(`Mitigation: ${mit}`, M+12, y+42, { width: INN-22, lineGap: 2 });
      y += rowH + 5;
    }

    // ── HIDDEN COST ROW ───────────────────────────────────────────────────
    function hiddenRow(item, est, exp) {
      const expH = doc.heightOfString(exp, { width: INN-20, lineGap: 2 });
      const rowH = 28 + expH + 8;
      checkY(rowH + 5);
      doc.roundedRect(M, y, INN, rowH, 4).fill(CARD);
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(LIGHT).text(item, M+10, y+10, { width: INN*0.58 });
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(TEAL).text(est, M+10, y+10, { width: INN-20, align: 'right' });
      doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text(exp, M+10, y+28, { width: INN-20, lineGap: 2 });
      y += rowH + 5;
    }

    // ── TIMELINE ROW ──────────────────────────────────────────────────────
    function tlRow(n, phase, dur, desc) {
      const descH = doc.heightOfString(desc, { width: INN-55, lineGap: 2 });
      const rowH = Math.max(50, 28 + descH + 10);
      checkY(rowH + 5);
      doc.roundedRect(M, y, INN, rowH, 4).fill(CARD);
      // Teal number column
      doc.roundedRect(M, y, 26, rowH, 4).fill(TEAL);
      doc.rect(M+22, y, 4, rowH).fill(TEAL);
      doc.fontSize(12).font('Helvetica-Bold').fillColor(NAVY)
         .text(String(n), M, y+rowH/2-8, { width: 26, align: 'center' });
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(LIGHT).text(phase, M+34, y+10, { width: INN-80 });
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(TEAL).text(dur, M+34, y+10, { width: INN-44, align: 'right' });
      doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text(desc, M+34, y+26, { width: INN-44, lineGap: 2 });
      y += rowH + 5;
    }

    // ── CHECKLIST ITEM ────────────────────────────────────────────────────
    function tickItem(text) {
      const h = doc.heightOfString(text, { width: INN-18, lineGap: 2 });
      checkY(h + 10);
      doc.fontSize(10).font('Helvetica-Bold').fillColor(TEAL).text('✓', M, y);
      doc.fontSize(9.5).font('Helvetica').fillColor(MUTED).text(text, M+18, y, { width: INN-18, lineGap: 2 });
      y += h + 8;
    }

    // ── STEP ITEM ─────────────────────────────────────────────────────────
    function stepItem(n, text) {
      const h = Math.max(30, doc.heightOfString(text, { width: INN-30, lineGap: 2 }) + 14);
      checkY(h + 5);
      doc.roundedRect(M, y, 22, h, 4).fill(TEAL);
      doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY)
         .text(String(n), M, y+h/2-7, { width: 22, align: 'center' });
      doc.fontSize(9.5).font('Helvetica').fillColor(MUTED).text(text, M+28, y+7, { width: INN-30, lineGap: 2 });
      y += h + 5;
    }

    // ── TOC ROW ───────────────────────────────────────────────────────────
    function tocRow(n, title) {
      checkY(28);
      doc.fontSize(10).font('Helvetica-Bold').fillColor(TEAL).text(n, M, y, { width: 18 });
      doc.fontSize(10).font('Helvetica').fillColor(LIGHT).text(title, M+22, y, { width: INN-22 });
      doc.rect(M, y+18, INN, 0.3).fill(BORD);
      y += 22;
    }

    // ══════════════════════════════════════════════════════════════════════
    // PAGE 1: COVER
    // ══════════════════════════════════════════════════════════════════════
    newPage();

    // Logo
    if (logoBase64) {
      try { doc.image(logoBase64, M, 20, { width: 20, height: 17 }); } catch(e) {}
    }

    // Tag + title
    doc.fontSize(8).font('Helvetica-Bold').fillColor(TEAL)
       .text('INTELLIGENCE REPORT', M, 46, { characterSpacing: 1.8 });
    doc.fontSize(26).font('Helvetica-Bold').fillColor(WHITE)
       .text(`${toolLbl} Cost\nIntelligence Report`, M, 62, { lineGap: 4 });

    const titleH = doc.heightOfString(`${toolLbl} Cost\nIntelligence Report`, { width: INN, fontSize: 26, lineGap: 4 });
    let cy = 62 + titleH + 20;

    doc.fontSize(10).font('Helvetica').fillColor(MUTED).text('Prepared for: ', M, cy, { continued: true })
       .font('Helvetica-Bold').fillColor(LIGHT).text(client);
    cy += 16;
    if (address) {
      doc.fontSize(10).font('Helvetica').fillColor(LIGHT).text(address, M, cy); cy += 14;
    }
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(`Report date: ${dateStr}`, M, cy);
    cy += 30;

    // Estimate box
    const EBH = 88;
    doc.roundedRect(M, cy, INN, EBH, 6).fill(CARD2);
    doc.rect(M, cy, 4, EBH).fill(TEAL);
    doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED)
       .text('ESTIMATED COST RANGE', M+14, cy+12, { characterSpacing: 1 });
    doc.fontSize(26).font('Helvetica-Bold').fillColor(TEAL)
       .text(`${lo} – ${hi}`, M+14, cy+26);
    doc.fontSize(9).font('Helvetica').fillColor(MUTED)
       .text(`${region}  ·  ${propType}  ·  ${spec} spec`, M+14, cy+66);
    cy += EBH + 16;

    // Details grid — 3 rows × 2 cols
    const details = isReno
      ? [['PROPERTY TYPE',propType],['REGION',region],
         ['RENOVATION LEVEL',level],['SPECIFICATION',spec],
         ['PROPERTY AGE',age],['BEDROOMS',beds]]
      : [['EXTENSION TYPE',level],['REGION',region],
         ['SPECIFICATION',spec],['COMPLEXITY',gv(estimate,'Complexity','complexity')],
         ['PROPERTY TYPE',propType],['REPORT DATE',dateStr]];

    const CW = INN/2, CH = 38;
    for (let i = 0; i < 6; i++) {
      const col = i%2, row = Math.floor(i/2);
      const cx = M + col*CW, cY = cy + row*CH;
      doc.rect(cx, cY, CW, CH).fill(CARD);
      doc.rect(cx, cY, CW, CH).stroke(BORD);
      doc.fontSize(6.5).font('Helvetica-Bold').fillColor(MUTED)
         .text((details[i]||['',''])[0], cx+10, cY+6, { characterSpacing: 0.8, width: CW-20 });
      doc.fontSize(11).font('Helvetica-Bold').fillColor(LIGHT)
         .text((details[i]||['',''])[1], cx+10, cY+18, { width: CW-20 });
    }
    cy += 3*CH + 14;

    // Discrete data source note
    doc.fontSize(6.5).font('Helvetica').fillColor(DIM)
       .text('Cost benchmarks informed by publicly available data from RICS, BCIS, ONS, Rightmove, Zoopla and HM Land Registry (2025/26). Full methodology at urbanbrief.co.uk/data-sources',
             M, cy, { width: INN });

    // ══════════════════════════════════════════════════════════════════════
    // PAGE 2: CONTENTS
    // ══════════════════════════════════════════════════════════════════════
    newSec(null, null);
    doc.fontSize(16).font('Helvetica-Bold').fillColor(WHITE).text('Contents', M, y); y += 24;
    rule();
    const TOC = [['1','Executive Summary'],['2','Cost Breakdown'],['3','Risk Factors'],
                 ['4','Hidden Costs'],['5','Contingency Guidance'],['6','Project Timeline'],
                 ['7','Contractor Briefing Checklist'],['8','Next Steps'],
                 ['9','Regional Market Context'],['10','Disclaimer & Data Sources']];
    TOC.forEach(([n,t]) => tocRow(n,t));

    // ══════════════════════════════════════════════════════════════════════
    // SECTIONS 1–9
    // ══════════════════════════════════════════════════════════════════════
    newSec('1','Executive Summary');
    bodyText(report.executiveSummary || '');

    newSec('2','Cost Breakdown');
    bodyText(`All figures are 2025/26 indicative estimates exclusive of VAT. ${region} regional multiplier applied.`);
    (report.costBreakdown||[]).forEach(r => costRow(r.item||'', r.low||'', r.high||'', r.notes||''));

    newSec('3','Risk Factors');
    bodyText('Risks identified based on property type, age and scope. Impact ranges use 2025/26 BCIS remediation data.');
    (report.riskFactors||[]).forEach(r => riskRow(r.risk||'', r.likelihood||'Low', r.impact||'', r.mitigation||''));

    newSec('4','Hidden Costs');
    bodyText('These costs are frequently omitted from initial budgets.');
    (report.hiddenCosts||[]).forEach(h => hiddenRow(h.item||'', h.estimate||'', h.explanation||''));

    newSec('5','Contingency Guidance');
    bodyText(report.contingencyGuidance || '');

    newSec('6','Project Timeline');
    bodyText('Indicative programme. Durations depend on contractor resource and unforeseen works.');
    (report.projectTimeline||[]).forEach((ph,i) => tlRow(i+1, ph.phase||'', ph.duration||'', ph.description||''));

    newSec('7','Contractor Briefing Checklist');
    bodyText('Present this checklist to all tendering contractors and include key items as contract conditions.');
    (report.contractorChecklist||[]).forEach(item => tickItem(item));

    newSec('8','Next Steps');
    const addrRef = address ? ` for ${address}` : '';
    bodyText(`Recommended actions in sequence${addrRef} before committing to any contract.`);
    (report.nextSteps||[]).forEach((s,i) => stepItem(i+1, s));

    newSec('9','Regional Market Context');
    bodyText(report.regionalContext || '');

    // ══════════════════════════════════════════════════════════════════════
    // SECTION 10: DISCLAIMER & DATA SOURCES
    // ══════════════════════════════════════════════════════════════════════
    newSec('10','Disclaimer & Data Sources');
    const disc = `This report provides indicative cost estimates based on publicly available 2025/26 UK construction cost data and the project details supplied. Actual costs will vary according to contractor, site conditions, specification changes, and market conditions at time of procurement. This report does not constitute professional advice. Always obtain a minimum of three competitive quotes from suitably qualified and insured contractors. UrbanBrief accepts no liability for decisions made on the basis of estimates herein. This report was prepared exclusively for ${client}${address?' at '+address:''} and should not be shared for any purpose other than initial budget planning.`;
    bodyText(disc);
    y += 8;

    // Data sources box
    const DS = 'Cost benchmarks informed by RICS (Royal Institution of Chartered Surveyors), BCIS (Building Cost Information Service), ONS (Office for National Statistics), Rightmove, Zoopla and HM Land Registry. All figures reference 2025/26 published indices. Full methodology: urbanbrief.co.uk/data-sources';
    const dsH = doc.heightOfString(DS, { width: INN-24, lineGap: 2 }) + 36;
    checkY(dsH + 10);
    doc.roundedRect(M, y, INN, dsH, 6).fill(CARD);
    doc.rect(M, y, 3, dsH).fill(TEAL);
    doc.fontSize(7).font('Helvetica-Bold').fillColor(TEAL)
       .text('DATA SOURCES', M+12, y+10, { characterSpacing: 1 });
    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
       .text(DS, M+12, y+24, { width: INN-22, lineGap: 2 });
    y += dsH + 10;

    // Sign-off line
    doc.rect(M, y, INN, 0.5).fill(BORD); y += 8;
    doc.fontSize(10).font('Helvetica-Bold').fillColor(TEAL).text('UrbanBrief', M, y);
    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
       .text('urbanbrief.co.uk  ·  enquiries@urbanbrief.co.uk', M, y+1, { width: INN, align: 'right' });

    doc.end();
  });
}


// ── EMAIL ─────────────────────────────────────────────────────

async function sendReportEmail(email, pdfBuffer, tool, report, estimate) {
  const lbl   = tool==='renovation'?'Renovation':'Extension';
  const _lo=get(estimate,'Estimate Low','estimateLow'), _hi=get(estimate,'Estimate High','estimateHigh');
  const estLow=_lo?(_lo.startsWith('\u00a3')?_lo:'\u00a3'+_lo):'—';
  const estHigh=_hi?(_hi.startsWith('\u00a3')?_hi:'\u00a3'+_hi):'—';
  const region=(get(estimate,'Region','region')+'').replace(/_/g,' ');
  const summary=(report.executiveSummary||'').substring(0,280)+'…';

  await resend.emails.send({
    from:    process.env.FROM_EMAIL||'noreply@urbanbrief.co.uk',
    to:      email,
    replyTo: 'enquiries@urbanbrief.co.uk',
    subject: `Your UrbanBrief ${lbl} Intelligence Report`,
    html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0d1117;font-family:Arial,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:32px 16px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;"><tr><td style="background:#151c26;border-radius:14px 14px 0 0;padding:28px 32px;border-bottom:1px solid rgba(255,255,255,0.09);"><img src="https://raw.githubusercontent.com/georgethepav/urbanbrief/main/UB-mono.png" width="32" height="27" style="vertical-align:middle;margin-right:10px;filter:invert(72%) sepia(54%) saturate(456%) hue-rotate(131deg) brightness(96%) contrast(86%);" alt="UB"><span style="font-size:18px;font-weight:700;color:#fff;vertical-align:middle;">UrbanBrief</span><span style="font-size:11px;color:#556070;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);border-radius:20px;padding:3px 10px;margin-left:10px;text-transform:uppercase;">Intelligence Report</span></td></tr><tr><td style="background:#151c26;padding:32px;"><p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#4fc3c3;text-transform:uppercase;letter-spacing:.14em;">Your report is attached</p><p style="margin:0 0 20px;font-size:22px;font-weight:700;color:#fff;">Your ${lbl} Intelligence Report</p><div style="background:#1a2235;border:1px solid rgba(79,195,195,.2);border-radius:12px;padding:24px;margin-bottom:20px;"><p style="margin:0 0 6px;font-size:10px;color:#556070;text-transform:uppercase;letter-spacing:.12em;">Estimated range</p><p style="margin:0 0 4px;font-size:28px;font-weight:700;color:#4fc3c3;">${estLow} – ${estHigh}</p><p style="margin:0;font-size:12px;color:#8a97aa;">${region}</p></div><p style="margin:0 0 20px;font-size:14px;color:#8a97aa;line-height:1.7;">${summary}</p><div style="background:#1a2235;border:1px solid rgba(79,195,195,.2);border-radius:10px;padding:20px;text-align:center;"><p style="margin:0 0 12px;font-size:13px;color:#8a97aa;">Your full report is attached — cost breakdown, risk factors, hidden costs, timeline and contractor checklist.</p><a href="https://urbanbrief.co.uk" style="display:inline-block;background:#4fc3c3;color:#0d1117;font-size:14px;font-weight:700;padding:11px 28px;border-radius:7px;text-decoration:none;">Visit UrbanBrief →</a></div></td></tr><tr><td style="background:#151c26;border-radius:0 0 14px 14px;border-top:1px solid rgba(255,255,255,0.09);padding:20px 32px;text-align:center;"><p style="margin:0;font-size:12px;color:#556070;">© 2025 UrbanBrief · <a href="https://urbanbrief.co.uk" style="color:#4fc3c3;text-decoration:none;">urbanbrief.co.uk</a></p></td></tr></table></td></tr></table></body></html>`,
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
