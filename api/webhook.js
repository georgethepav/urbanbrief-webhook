// ================================================================
// UrbanBrief — Phase 2 Stripe Webhook Handler v2
// Uses Apps Script for data lookup — no Google Cloud needed
// ================================================================

import Stripe from 'stripe';
import { Resend } from 'resend';
import OpenAI from 'openai';
import PDFDocument from 'pdfkit';
import getRawBody from 'raw-body';

const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend  = new Resend(process.env.RESEND_API_KEY);
const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

  // ── Respond to Stripe IMMEDIATELY to prevent retries ──
  // Stripe retries if it doesn't get a 200 within ~30s.
  // We do the heavy work (OpenAI + PDF + email) asynchronously after responding.
  res.status(200).json({ received: true, processing: true });

  // Now do the work — any errors are logged but don't affect the Stripe response
  try {
    const { estimate, extra } = await lookupBuyerData(email);
    if (!estimate) { console.error('No estimate found for:', email); return; }

    const tool = (estimate['Tool'] || estimate['tool'] || 'renovation').toLowerCase();
    const reportContent = await generateReport(estimate, extra, tool);
    const pdfBuffer = await generatePDF(reportContent, estimate, tool, extra);
    await sendReportEmail(email, pdfBuffer, tool, reportContent, estimate);
    await markAsPaid(email);

    console.log('Report sent to:', email);
  } catch (err) {
    console.error('Report generation failed for', email, ':', err.message);
    // Already sent 200 to Stripe above — do not send another response
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

function toTitle(s) {
  if (!s) return '';
  // Expand known shorthand values first
  const expansions = {
    'semi':        'Semi-detached',
    'detached':    'Detached',
    'terrace':     'Terraced',
    'bungalow':    'Bungalow',
    'flat':        'Flat',
    'london':      'London',
    'south_east':  'South East',
    'midlands':    'Midlands',
    'north':       'North England',
    'scotland':    'Scotland',
    'wales':       'Wales',
    'basic':       'Basic',
    'midrange':    'Mid-range',
    'highspec':    'High Spec',
    'luxury':      'Luxury',
    'cosmetic':    'Cosmetic Refresh',
    'full':        'Full Renovation',
    'full_layout': 'Full + Layout Changes',
    'full_ext':    'Full + Extension',
    'pre1920':     'Pre-1920',
    '1920_1960':   '1920–1960',
    '1960_1990':   '1960–1990',
    '1990_2010':   '1990–2010',
    '2010plus':    '2010+',
    'rear_single': 'Rear Single-Storey',
    'rear_two':    'Rear Two-Storey',
    'sides_single':'Two+ Sides Single-Storey',
    'sides_two':   'Two+ Sides Two-Storey',
    'loft':        'Loft Conversion',
    'sub80':       'Under 80m²',
    '80_120':      '80–120m²',
    '120_160':     '120–160m²',
    '160plus':     '160m²+',
  };
  const lower = String(s).toLowerCase().trim();
  if (expansions[lower]) return expansions[lower];
  return String(s)
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

function fmtPound(v) {
  if (!v || v === '—') return '—';
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  if (isNaN(n)) return v;
  return '£' + Math.round(n).toLocaleString('en-GB');
}

function get(obj, ...keys) {
  if (!obj) return '';
  for (const k of keys) {
    // Exact match first
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return String(obj[k]);
    // Normalised match (strips spaces, underscores, slashes, hyphens)
    const lk = k.toLowerCase().replace(/[\s/_\-]/g, '');
    const match = Object.keys(obj).find(ok => ok.toLowerCase().replace(/[\s/_\-]/g, '') === lk);
    if (match !== undefined && obj[match] !== undefined && obj[match] !== null && obj[match] !== '') return String(obj[match]);
  }
  return '';
}

// ── OPENAI ────────────────────────────────────────────────────

async function generateReport(estimate, extra, tool) {
  const isReno   = tool === 'renovation';
  const region   = toTitle(get(estimate, 'Region', 'region'));
  const propType = toTitle(get(estimate, 'Property Type', 'propertyType'));
  const level    = toTitle(get(estimate, 'Level / Type', 'levelOrType', 'Level/Type'));
  const spec     = toTitle(get(estimate, 'Spec', 'spec'));
  const age      = toTitle(get(estimate, 'Age', 'age'));
  const beds     = get(estimate, 'Bedrooms', 'bedrooms');
  const floorArea= toTitle(get(extra||{}, 'floorArea', 'Floor Area', 'fa') || get(estimate, 'Floor Area', 'floorArea'));
  const rawLow   = get(estimate, 'Estimate Low', 'estimateLow');
  const rawHigh  = get(estimate, 'Estimate High', 'estimateHigh');
  const estLow   = fmtPound(rawLow);
  const estHigh  = fmtPound(rawHigh);
  const houseNo  = get(extra||{}, 'houseNo', 'House No/Name', 'houseno');
  const postcode = get(extra||{}, 'postcode', 'Postcode');
  const address  = [houseNo, postcode].filter(p => p && p !== '—').join(', ');

  const extraLines = [];
  if (extra) {
    const keys = isReno
      ? ['House No/Name','Postcode','Electrical','Heating','Plumbing','Windows','Structural','External Works']
      : ['Property Age','Ground Conditions','Planning Situation','Site Access','Party Wall','Glazing Spec','Kitchen','Bathrooms','Interior Finish'];
    keys.forEach(k => { const v = get(extra, k); if (v) extraLines.push(`${k}: ${v}`); });
  }

  const systemPrompt = `You are a Principal Designer and cost consultant specialising in UK residential renovation and extension projects. You write detailed, specific, professional Intelligence Reports in British English. Your reports are used by homeowners to plan and budget major projects — they must be accurate, thorough and actionable. Never use generic filler text. Always reference the specific property type, age, region and specification provided. Use 2025/26 as the reference year for all cost data and market commentary.`;

  const projectSummary = isReno
    ? `PROJECT TYPE: Full Renovation
Property: ${propType} | Bedrooms: ${beds} | Floor area: ${floorArea} | Age: ${age}
Region: ${region} | Scope: ${level} | Specification: ${spec}
Estimate: ${estLow} – ${estHigh}
Address: ${address || 'Not provided'}
Extra details: ${extraLines.length ? extraLines.join(' | ') : 'None provided'}`
    : `PROJECT TYPE: Extension
Property: ${propType} | Extension type: ${level} | Specification: ${spec}
Region: ${region}
Estimate: ${estLow} – ${estHigh}
Address: ${address || 'Not provided'}
Extra details: ${extraLines.length ? extraLines.join(' | ') : 'None provided'}`;

  const userPrompt = `Generate a full Intelligence Report for the project below. Output ONLY valid JSON — no markdown, no backticks, no preamble.

${projectSummary}

QUALITY REQUIREMENTS — every section must meet these standards:

EXECUTIVE SUMMARY (4 paragraphs):
- Para 1: Introduce the specific project — reference the property type, age, region, floor area, scope and specification. State the estimate range and what it covers.
- Para 2: Comment on the structural characteristics and risk profile typical of this property age/type. Be specific — e.g. cavity wall vs solid wall, timber floors, roof type, services age.
- Para 3: Reference the regional construction market — tender price inflation, contractor availability, lead times in this region for 2025/26.
- Para 4: If a postcode/address was provided, include a brief note on the local property market context and how renovation/extension investment performs in that area.

COST BREAKDOWN (6-8 items):
- Each item must have a descriptive "notes" field explaining: what is included, the cost basis (e.g. BCIS 2025/26 index, rate per m²), and any key assumptions.
- Include base works, kitchen (if applicable), bathrooms (if applicable), any structural items, contingency, and a total inc. contingency line.
- Low and high values must be specific £ figures consistent with the estimate range provided.

RISK FACTORS (4-5 items):
- Each risk must be specific to THIS property's age, type and scope — not generic.
- "impact" field: give a specific £ range e.g. "£2,500–£6,000"
- "mitigation" field: 2-3 sentences of specific, actionable advice referencing the property type and age.
- likelihood: "High", "Medium" or "Low" only.

HIDDEN COSTS (5-6 items):
- Each must have a specific £ estimate range and a 2-3 sentence explanation with practical guidance.
- Must include: VAT, professional fees, temporary accommodation (if applicable), party wall (if applicable), building regulations, waste disposal.

CONTINGENCY GUIDANCE (1 field, 3-4 paragraphs):
- Para 1: State the recommended % and total £ range based on the actual estimate figures.
- Para 2: Split into general contingency and services contingency with specific £ figures for each.
- Para 3: Reference the highest single risk item for this specific property age and explain its cost range.
- Para 4: Practical advice on how to hold and release contingency during the project.

PROJECT TIMELINE (6 phases):
- Each phase must have a realistic duration and a "description" of 2-3 sentences covering what specifically happens in that phase for this project type and scope.
- Phases: pre-works/procurement, strip-out, structural/first-fix services, second-fix/plastering, finishes/fit-out, commissioning/snagging.

CONTRACTOR CHECKLIST (8-10 items):
- Specific to the project scope and specification level. Include insurance levels appropriate to the project value.

NEXT STEPS (6 items):
- Specific, actionable steps in sequence. Reference the property address if provided. Include UrbanBrief contact as final step.

REGIONAL CONTEXT (3 paragraphs):
- Para 1: Tender price inflation and market conditions in this specific region for 2025/26 with % figures.
- Para 2: Material cost trends relevant to this scope.
- Para 3: Labour market conditions and any specific local factors affecting this project.

Return this exact JSON structure:
{
  "executiveSummary": "4 paragraphs separated by newlines",
  "costBreakdown": [{"item": "", "low": "£XX,000", "high": "£XX,000", "notes": "2-3 sentence explanation"}],
  "riskFactors": [{"risk": "", "likelihood": "High/Medium/Low", "impact": "£X,000–£X,000", "mitigation": "2-3 sentences"}],
  "hiddenCosts": [{"item": "", "estimate": "£X,000–£X,000", "explanation": "2-3 sentences"}],
  "contingencyGuidance": "3-4 paragraphs separated by newlines",
  "projectTimeline": [{"phase": "", "duration": "X–X weeks", "description": "2-3 sentences"}],
  "contractorChecklist": ["full sentence item"],
  "nextSteps": ["full sentence step"],
  "regionalContext": "3 paragraphs separated by newlines"
}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    temperature: 0.35,
    max_tokens: 6000,
  });

  const raw = response.choices[0].message.content.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(raw);
}


// ── PDF ────────────────────────────────────────────────────────────────────────

async function generatePDF(report, estimate, tool, extra) {
  let logoBuf = null;
  try {
    const r = await fetch('https://raw.githubusercontent.com/georgethepav/urbanbrief/main/UB-mono.png');
    logoBuf = Buffer.from(await r.arrayBuffer());
  } catch(e) { console.error('Logo fetch failed:', e.message); }

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margin: 0, compress: true, autoFirstPage: false });
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── PALETTE ──────────────────────────────────────────────────────────
    const C = {
      navy:  '#0d1117', card:  '#151c26', card2: '#1a2235',
      teal:  '#4fc3c3', muted: '#8a97aa', light: '#e8edf4',
      bord:  '#1e2840', dim:   '#404c5e', white: '#ffffff',
      red:   '#e05252', amber: '#e8c84c', green: '#4cba6e',
    };
    const W = 595.28, H = 841.89, M = 51, INN = W - 2*M;
    const HDR_H  = 51;   // header bar height (pages 2+)
    const FTR_H  = 34;   // footer bar height
    const TOP    = HDR_H + 10;   // content starts here
    const BOT    = H - FTR_H - 10; // content ends here
    const isReno = tool === 'renovation';
    const lbl    = isReno ? 'Renovation' : 'Extension';

    // ── DATA ─────────────────────────────────────────────────────────────
    const propType  = toTitle(get(estimate, 'Property Type', 'propertyType'));
    const region    = toTitle(get(estimate, 'Region', 'region'));
    const level     = toTitle(get(estimate, 'Level / Type', 'levelOrType', 'Level/Type'));
    const spec      = toTitle(get(estimate, 'Spec', 'spec'));
    const age       = toTitle(get(estimate, 'Age', 'age'));
    const beds      = get(estimate, 'Bedrooms', 'bedrooms');
    const floorArea = toTitle(get(extra||{}, 'floorArea','Floor Area','fa') || get(estimate,'Floor Area','floorArea'));
    const rawLo     = get(estimate, 'Estimate Low',  'estimateLow');
    const rawHi     = get(estimate, 'Estimate High', 'estimateHigh');
    const lo        = fmtPound(rawLo);
    const hi        = fmtPound(rawHi);
    const client    = get(estimate, 'Email', 'email') || '';
    const houseNo   = get(extra||{}, 'houseNo', 'House No/Name', 'houseno') || '';
    const postcode  = get(extra||{}, 'postcode', 'Postcode') || '';
    const address   = [houseNo, postcode].filter(p => p && p !== '—').join(', ');
    const dateStr   = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    // ── HELPERS ──────────────────────────────────────────────────────────
    let pgNum = 0;

    function addPage() {
      pgNum++;
      doc.addPage({ size: 'A4', margin: 0 });
      // Navy full background
      doc.rect(0, 0, W, H).fill(C.navy);
      // Top teal strip
      doc.rect(0, 0, W, 3).fill(C.teal);
    }

    function drawCover() {
      // Bottom data strip
      doc.rect(0, H - 28, W, 28).fill(C.card);
      doc.rect(0, H - 28, W, 0.4).fill(C.bord);
      doc.fontSize(6.5).font('Helvetica').fillColor(C.dim)
         .text('Informed by: RICS · BCIS · ONS · Rightmove · Zoopla · HM Land Registry — 2025/26 data',
               M, H - 17, { width: INN, align: 'center' });
    }

    function drawChrome() {
      // Header
      doc.rect(0, 3, W, HDR_H - 3).fill(C.card);
      doc.rect(0, HDR_H, W, 0.4).fill(C.bord);
      if (logoBuf) { try { doc.image(logoBuf, M, 10, { width: 20, height: 17 }); } catch(e) {} }
      doc.fontSize(9).font('Helvetica-Bold').fillColor(C.white).text('UrbanBrief', M + 24, 13);
      doc.fontSize(7).font('Helvetica').fillColor(C.muted).text('Intelligence Report', M + 24, 25);
      if (address) {
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor(C.teal)
           .text(address, M, 13, { width: INN, align: 'right' });
      }
      doc.fontSize(6.5).font('Helvetica').fillColor(C.muted)
         .text('Prepared for: ' + client + '  ·  Page ' + pgNum, M, 25, { width: INN, align: 'right' });
      // Footer
      doc.rect(0, H - FTR_H, W, FTR_H).fill(C.card);
      doc.rect(0, H - FTR_H, W, 0.4).fill(C.bord);
      const foot = address
        ? lbl + ' estimate for ' + client + '  ·  ' + address + '  ·  ' + dateStr
        : lbl + ' estimate for ' + client + '  ·  ' + dateStr;
      doc.fontSize(6.5).font('Helvetica').fillColor(C.muted)
         .text(foot, M, H - FTR_H + 9, { width: INN - 70 });
      doc.fontSize(6.5).fillColor(C.muted)
         .text('CONFIDENTIAL', M, H - FTR_H + 9, { width: INN, align: 'right' });
      doc.fontSize(6).fillColor(C.dim)
         .text('urbanbrief.co.uk  ·  enquiries@urbanbrief.co.uk', M, H - FTR_H + 21);
    }

    // Current Y tracker
    let y = TOP;

    function needY(h) {
      if (y + h > BOT) {
        addPage();
        drawChrome();
        y = TOP + 6;
      }
    }

    function secPage(num, title) {
      addPage();
      drawChrome();
      y = TOP + 8;
      if (num && title) {
        doc.fontSize(15).font('Helvetica-Bold').fillColor(C.white)
           .text(num + '.  ' + title, M, y);
        y += 22;
        doc.rect(M, y, INN, 0.5).fill(C.bord);
        y += 8;
      }
    }

    function bodyTxt(text) {
      if (!text) return;
      // Split on double newlines or single newlines for multi-paragraph content
      const paras = String(text).split(/\n\n|\n/).map(p => p.trim()).filter(Boolean);
      paras.forEach((para, i) => {
        const t = para.replace(/(\b2025\b)(?!\/)/g, '2025/26');
        doc.fontSize(9.5).font('Helvetica').fillColor(C.muted);
        const h = doc.heightOfString(t, { width: INN, lineGap: 3 });
        needY(h + 8);
        doc.text(t, M, y, { width: INN, lineGap: 3 });
        y += h + (i < paras.length - 1 ? 10 : 8); // extra gap between paragraphs
      });
    }

    function hRule() {
      needY(8);
      doc.rect(M, y, INN, 0.4).fill(C.bord);
      y += 6;
    }

    function tocRow(n, title) {
      needY(24);
      doc.fontSize(10).font('Helvetica-Bold').fillColor(C.teal).text(String(n), M, y, { width: 18 });
      doc.fontSize(10).font('Helvetica').fillColor(C.light).text(title, M + 22, y, { width: INN - 22 });
      doc.rect(M, y + 18, INN, 0.3).fill(C.bord);
      y += 22;
    }

    function costRow(item, cLo, cHi, notes) {
      doc.fontSize(9.5).font('Helvetica').fillColor(C.muted);
      const noteH = notes ? doc.heightOfString(notes, { width: INN - 20, lineGap: 2 }) + 4 : 0;
      const rH = 30 + noteH;
      needY(rH + 5);
      doc.roundedRect(M, y, INN, rH, 4).fill(C.card);
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(C.light)
         .text(item, M + 10, y + 9, { width: INN * 0.54 });
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(C.teal)
         .text(cLo + ' – ' + cHi, M + 10, y + 9, { width: INN - 20, align: 'right' });
      if (notes) {
        doc.fontSize(7.5).font('Helvetica').fillColor(C.muted)
           .text(notes, M + 10, y + 26, { width: INN - 20, lineGap: 2 });
      }
      doc.rect(M, y + rH - 0.4, INN, 0.4).fill(C.bord);
      y += rH + 5;
    }

    function riskRow(risk, lh, impact, mit) {
      const col = lh === 'High' ? C.red : lh === 'Medium' ? C.amber : C.green;
      doc.fontSize(8.5).font('Helvetica').fillColor(C.muted);
      const mitH = doc.heightOfString('Mitigation: ' + mit, { width: INN - 22, lineGap: 2 });
      const rH = 40 + mitH + 8;
      needY(rH + 5);
      doc.roundedRect(M, y, INN, rH, 4).fill(C.card);
      doc.rect(M, y, 3, rH).fill(col);
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(C.light)
         .text(risk, M + 12, y + 9, { width: INN * 0.68 });
      doc.fontSize(8).font('Helvetica-Bold').fillColor(col)
         .text(lh + ' risk', M + 12, y + 9, { width: INN - 22, align: 'right' });
      doc.fontSize(8.5).font('Helvetica').fillColor(C.muted)
         .text('Impact: ' + impact, M + 12, y + 26, { width: INN - 22 });
      doc.text('Mitigation: ' + mit, M + 12, y + 38, { width: INN - 22, lineGap: 2 });
      y += rH + 5;
    }

    function hiddenRow(item, est, exp) {
      doc.fontSize(8.5).font('Helvetica').fillColor(C.muted);
      const expH = doc.heightOfString(exp, { width: INN - 20, lineGap: 2 });
      const rH = 28 + expH + 8;
      needY(rH + 5);
      doc.roundedRect(M, y, INN, rH, 4).fill(C.card);
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(C.light)
         .text(item, M + 10, y + 9, { width: INN * 0.58 });
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(C.teal)
         .text(est, M + 10, y + 9, { width: INN - 20, align: 'right' });
      doc.fontSize(8.5).font('Helvetica').fillColor(C.muted)
         .text(exp, M + 10, y + 26, { width: INN - 20, lineGap: 2 });
      y += rH + 5;
    }

    function tlRow(n, phase, dur, desc) {
      doc.fontSize(8.5).font('Helvetica').fillColor(C.muted);
      const dH = doc.heightOfString(desc, { width: INN - 55, lineGap: 2 });
      const rH = Math.max(48, 26 + dH + 10);
      needY(rH + 5);
      doc.roundedRect(M, y, INN, rH, 4).fill(C.card);
      doc.roundedRect(M, y, 26, rH, 4).fill(C.teal);
      doc.rect(M + 22, y, 4, rH).fill(C.teal);
      doc.fontSize(12).font('Helvetica-Bold').fillColor(C.navy)
         .text(String(n), M, y + rH / 2 - 8, { width: 26, align: 'center' });
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor(C.light)
         .text(phase, M + 34, y + 9, { width: INN - 80 });
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(C.teal)
         .text(dur, M + 34, y + 9, { width: INN - 44, align: 'right' });
      doc.fontSize(8.5).font('Helvetica').fillColor(C.muted)
         .text(desc, M + 34, y + 26, { width: INN - 44, lineGap: 2 });
      y += rH + 5;
    }

    function tickItem(text) {
      doc.fontSize(9.5).font('Helvetica').fillColor(C.muted);
      const h = doc.heightOfString(text, { width: INN - 18, lineGap: 2 });
      needY(h + 8);
      doc.fontSize(10).font('Helvetica-Bold').fillColor(C.teal).text('✓', M, y);
      doc.fontSize(9.5).font('Helvetica').fillColor(C.muted)
         .text(text, M + 18, y, { width: INN - 18, lineGap: 2 });
      y += h + 7;
    }

    function stepItem(n, text) {
      doc.fontSize(9.5).font('Helvetica').fillColor(C.muted);
      const h = Math.max(28, doc.heightOfString(text, { width: INN - 30, lineGap: 2 }) + 14);
      needY(h + 5);
      doc.roundedRect(M, y, 22, h, 4).fill(C.teal);
      doc.fontSize(9).font('Helvetica-Bold').fillColor(C.navy)
         .text(String(n), M, y + h / 2 - 7, { width: 22, align: 'center' });
      doc.fontSize(9.5).font('Helvetica').fillColor(C.muted)
         .text(text, M + 28, y + 7, { width: INN - 30, lineGap: 2 });
      y += h + 5;
    }

    // ════════════════════════════════════════════════════════════════════
    // PAGE 1 — COVER
    // ════════════════════════════════════════════════════════════════════
    addPage();
    drawCover();

    // Logo — large top right
    if (logoBuf) { try { doc.image(logoBuf, W - M - 52, 16, { width: 52, height: 44 }); } catch(e) {} }

    let cy = 22;
    doc.fontSize(8).font('Helvetica-Bold').fillColor(C.teal)
       .text('INTELLIGENCE REPORT', M, cy, { characterSpacing: 1.8 });
    cy += 20;
    doc.fontSize(24).font('Helvetica-Bold').fillColor(C.white)
       .text(lbl + ' Cost Intelligence Report', M, cy, { width: W - M - 70, lineGap: 4 });
    cy += doc.heightOfString(lbl + ' Cost Intelligence Report',
          { width: W - M - 70, fontSize: 24, lineGap: 4 }) + 18;

    doc.fontSize(10).font('Helvetica').fillColor(C.muted)
       .text('Prepared for:  ', M, cy, { continued: true })
       .font('Helvetica-Bold').fillColor(C.light).text(client, { continued: false });
    cy += 16;
    if (address) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor(C.teal).text(address, M, cy);
      cy += 18;
    }
    doc.fontSize(9).font('Helvetica').fillColor(C.muted).text('Report date: ' + dateStr, M, cy);
    cy += 28;

    // Estimate band
    const EBH = 86;
    doc.roundedRect(M, cy, INN, EBH, 6).fill(C.card2);
    doc.rect(M, cy, 4, EBH).fill(C.teal);
    doc.fontSize(7).font('Helvetica-Bold').fillColor(C.muted)
       .text('ESTIMATED COST RANGE', M + 14, cy + 10, { characterSpacing: 1 });
    doc.fontSize(26).font('Helvetica-Bold').fillColor(C.teal)
       .text(lo + ' – ' + hi, M + 14, cy + 24);
    doc.fontSize(9).font('Helvetica').fillColor(C.muted)
       .text(region + '  ·  ' + propType + '  ·  ' + spec + ' spec', M + 14, cy + 62);
    cy += EBH + 14;

    // Details grid — 3 rows × 2 cols, 38px tall each
    const detailsReno = [
      ['PROPERTY TYPE',   propType],  ['REGION',        region],
      ['RENOVATION LEVEL',level],     ['SPECIFICATION', spec],
      ['PROPERTY AGE',    age],       ['FLOOR AREA',    floorArea || (beds + ' bed')],
    ];
    const detailsExt = [
      ['EXTENSION TYPE',  level],     ['REGION',        region],
      ['SPECIFICATION',   spec],      ['PROPERTY TYPE', propType],
      ['PROPERTY AGE',    age],       ['REPORT DATE',   dateStr],
    ];
    const details = isReno ? detailsReno : detailsExt;
    const CW = INN / 2, CH = 38;
    for (let i = 0; i < 6; i++) {
      const col = i % 2, row = Math.floor(i / 2);
      const cx = M + col * CW, gy = cy + row * CH;
      doc.rect(cx, gy, CW, CH).fill(C.card);
      doc.rect(cx, gy, CW, CH).stroke(C.bord);
      doc.fontSize(6.5).font('Helvetica-Bold').fillColor(C.muted)
         .text(details[i][0], cx + 10, gy + 6, { characterSpacing: 0.8, width: CW - 20 });
      doc.fontSize(10.5).font('Helvetica-Bold').fillColor(C.light)
         .text(details[i][1], cx + 10, gy + 18, { width: CW - 20 });
    }
    cy += 3 * CH + 14;

    // Data source note
    doc.fontSize(6.5).font('Helvetica').fillColor(C.dim)
       .text('Cost benchmarks informed by RICS, BCIS, ONS, Rightmove, Zoopla and HM Land Registry (2025/26). Full methodology at urbanbrief.co.uk/data-sources',
             M, cy, { width: INN });

    // ════════════════════════════════════════════════════════════════════
    // PAGE 2 — CONTENTS
    // ════════════════════════════════════════════════════════════════════
    secPage(null, null);
    doc.fontSize(16).font('Helvetica-Bold').fillColor(C.white).text('Contents', M, y);
    y += 24;
    hRule();
    const toc = [
      ['1','Executive Summary'], ['2','Cost Breakdown'], ['3','Risk Factors'],
      ['4','Hidden Costs'], ['5','Contingency Guidance'], ['6','Project Timeline'],
      ['7','Contractor Briefing Checklist'], ['8','Next Steps'],
      ['9','Regional Market Context'], ['10','Disclaimer & Data Sources'],
    ];
    toc.forEach(([n, t]) => tocRow(n, t));

    // ════════════════════════════════════════════════════════════════════
    // SECTIONS
    // ════════════════════════════════════════════════════════════════════
    secPage('1', 'Executive Summary');
    bodyTxt(report.executiveSummary || '');

    secPage('2', 'Cost Breakdown');
    bodyTxt('All figures are 2025/26 indicative estimates exclusive of VAT. ' + region + ' regional multiplier applied.');
    (report.costBreakdown || []).forEach(r => costRow(r.item||'', r.low||'', r.high||'', r.notes||''));

    secPage('3', 'Risk Factors');
    bodyTxt('Risks identified based on property type, age and scope. Impact ranges use 2025/26 BCIS data.');
    (report.riskFactors || []).forEach(r => riskRow(r.risk||'', r.likelihood||'Low', r.impact||'', r.mitigation||''));

    secPage('4', 'Hidden Costs');
    bodyTxt('These costs are frequently omitted from initial budgets — include them from the outset.');
    (report.hiddenCosts || []).forEach(h => hiddenRow(h.item||'', h.estimate||'', h.explanation||''));

    secPage('5', 'Contingency Guidance');
    bodyTxt(report.contingencyGuidance || '');

    secPage('6', 'Project Timeline');
    bodyTxt('Indicative programme. Durations depend on contractor resource and unforeseen works.');
    (report.projectTimeline || []).forEach((ph, i) =>
      tlRow(i + 1, ph.phase||'', ph.duration||'', ph.description||''));

    secPage('7', 'Contractor Briefing Checklist');
    bodyTxt('Present this checklist to all tendering contractors and include key items as contract conditions.');
    (report.contractorChecklist || []).forEach(item => tickItem(item));

    secPage('8', 'Next Steps');
    bodyTxt('Recommended actions in sequence' + (address ? ' for ' + address : '') + ' before committing to any contract.');
    (report.nextSteps || []).forEach((s, i) => stepItem(i + 1, s));

    secPage('9', 'Regional Market Context');
    bodyTxt(report.regionalContext || '');

    // ════════════════════════════════════════════════════════════════════
    // SECTION 10 — DISCLAIMER
    // ════════════════════════════════════════════════════════════════════
    secPage('10', 'Disclaimer & Data Sources');
    const disc = 'This report provides indicative cost estimates based on publicly available 2025/26 UK construction cost data and the project details supplied. Actual costs will vary according to contractor, site conditions, specification changes, and market conditions at time of procurement. This report does not constitute professional advice. Always obtain a minimum of three competitive quotes from suitably qualified and insured contractors before committing to any works. UrbanBrief accepts no liability for decisions made on the basis of estimates herein. This report was prepared exclusively for ' + client + (address ? ' at ' + address : '') + ' and should not be shared for any purpose other than initial budget planning.';
    bodyTxt(disc);
    y += 10;

    const DS = 'Cost benchmarks informed by RICS (Royal Institution of Chartered Surveyors), BCIS (Building Cost Information Service), ONS (Office for National Statistics), Rightmove, Zoopla and HM Land Registry. All figures reference 2025/26 published indices. Full methodology: urbanbrief.co.uk/data-sources';
    doc.fontSize(8.5).font('Helvetica').fillColor(C.muted);
    const dsH = doc.heightOfString(DS, { width: INN - 24, lineGap: 2 }) + 36;
    needY(dsH + 10);
    doc.roundedRect(M, y, INN, dsH, 6).fill(C.card);
    doc.rect(M, y, 3, dsH).fill(C.teal);
    doc.fontSize(7).font('Helvetica-Bold').fillColor(C.teal)
       .text('DATA SOURCES', M + 12, y + 10, { characterSpacing: 1 });
    doc.fontSize(8).font('Helvetica').fillColor(C.muted)
       .text(DS, M + 12, y + 24, { width: INN - 22, lineGap: 2 });
    y += dsH + 10;

    needY(28);
    doc.rect(M, y, INN, 0.5).fill(C.bord);
    y += 8;
    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.teal).text('UrbanBrief', M, y);
    doc.fontSize(8).font('Helvetica').fillColor(C.muted)
       .text('urbanbrief.co.uk  ·  enquiries@urbanbrief.co.uk', M, y + 1, { width: INN, align: 'right' });

    doc.end();
  });
}


// ── EMAIL ─────────────────────────────────────────────────────

async function sendReportEmail(email, pdfBuffer, tool, report, estimate) {
  const lbl   = tool==='renovation'?'Renovation':'Extension';
  const estLow  = fmtPound(get(estimate,'Estimate Low','estimateLow'));
  const estHigh = fmtPound(get(estimate,'Estimate High','estimateHigh'));
  const region = toTitle(get(estimate,'Region','region'));
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

