// ================================================================
// UrbanBrief — Phase 2 Stripe Webhook Handler
// Deploy to: Vercel (free tier) as /api/webhook.js
// ================================================================

const stripe        = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { google }    = require('googleapis');
const { Resend }    = require('resend');
const OpenAI        = require('openai');
const PDFDocument   = require('pdfkit');

const resend  = new Resend(process.env.RESEND_API_KEY);
const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SHEET_ID       = process.env.GOOGLE_SHEET_ID;
const ESTIMATES_TAB  = 'Estimates';
const EXTRA_TAB      = 'Extra Questions';

// ── MAIN ENTRY POINT ─────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify Stripe signature
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // Only handle successful payments
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, ignored: true });
  }

  const session = event.data.object;

  // Must be paid
  if (session.payment_status !== 'paid') {
    return res.status(200).json({ received: true, ignored: 'not paid' });
  }

  const email = session.customer_details?.email;
  if (!email) {
    console.error('No email in webhook payload');
    return res.status(200).json({ received: true, error: 'no email' });
  }

  console.log('Processing paid report for:', email);

  try {
    // 1. Fetch data from both Google Sheets tabs
    const sheets   = await getSheetsClient();
    const estimate = await getLatestRow(sheets, ESTIMATES_TAB, email);
    const extra    = await getLatestRow(sheets, EXTRA_TAB, email);

    if (!estimate) {
      console.error('No estimate found for email:', email);
      return res.status(200).json({ received: true, error: 'no estimate found' });
    }

    const tool = estimate.tool || 'renovation';

    // 2. Generate report content via OpenAI
    const reportContent = await generateReport(estimate, extra, tool);

    // 3. Generate PDF
    const pdfBuffer = await generatePDF(reportContent, estimate, tool);

    // 4. Send email with PDF attached
    await sendReportEmail(email, pdfBuffer, tool, reportContent, estimate);

    // 5. Update Sheet rows to mark as paid/sent
    await markAsPaid(sheets, ESTIMATES_TAB, email);
    await markAsPaid(sheets, EXTRA_TAB, email, 'Paid Intent');

    console.log('Report sent successfully to:', email);
    return res.status(200).json({ success: true, email });

  } catch (err) {
    console.error('Error processing report:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── GOOGLE SHEETS ─────────────────────────────────────────────

async function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getLatestRow(sheets, tabName, email) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${tabName}!A:Z`,
    });
    const rows = response.data.values || [];
    if (rows.length < 2) return null;

    const headers = rows[0];
    const emailCol = headers.findIndex(h => h.toLowerCase().includes('email'));
    if (emailCol === -1) return null;

    // Find the most recent row matching email (search from bottom)
    for (let i = rows.length - 1; i >= 1; i--) {
      if ((rows[i][emailCol] || '').toLowerCase() === email.toLowerCase()) {
        // Convert row to object using headers
        const obj = {};
        headers.forEach((h, idx) => {
          // Normalise header to camelCase key
          const key = h.toLowerCase()
            .replace(/[^a-z0-9 ]/g, '')
            .trim()
            .replace(/ (.)/g, (_, c) => c.toUpperCase());
          obj[key] = rows[i][idx] || '';
        });
        // Store original row index (1-based, accounting for header)
        obj._rowIndex = i + 1;
        return obj;
      }
    }
    return null;
  } catch (err) {
    console.error(`Error reading ${tabName}:`, err.message);
    return null;
  }
}

async function markAsPaid(sheets, tabName, email, colName) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${tabName}!A1:Z1`,
    });
    const headers = response.data.values?.[0] || [];
    const targetHeader = colName
      ? headers.findIndex(h => h.toLowerCase().includes(colName.toLowerCase().split(' ')[0]))
      : headers.findIndex(h => h.toLowerCase().includes('purchased') || h.toLowerCase().includes('paid'));

    if (targetHeader === -1) return;

    // Get the row index for this email
    const allRows = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${tabName}!A:A`,
    });
    const emailCol = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${tabName}!B:B`,
    });
    const emailRows = emailCol.data.values || [];
    let rowIndex = -1;
    for (let i = emailRows.length - 1; i >= 1; i--) {
      if ((emailRows[i]?.[0] || '').toLowerCase() === email.toLowerCase()) {
        rowIndex = i + 1; // 1-based
        break;
      }
    }

    if (rowIndex === -1) return;

    const col = String.fromCharCode(65 + targetHeader);
    const timestamp = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tabName}!${col}${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[`Yes — ${timestamp}`]] },
    });
  } catch (err) {
    console.error(`Error updating ${tabName}:`, err.message);
  }
}

// ── OPENAI REPORT GENERATION ──────────────────────────────────

async function generateReport(estimate, extra, tool) {
  const isReno = tool === 'renovation';

  let extraDetails = '';
  if (extra) {
    if (isReno) {
      extraDetails = [
        extra.postcode        && `Postcode: ${extra.postcode}`,
        extra.floorArea       && `Floor area: ${extra.floorArea}`,
        extra.electrical      && `Electrical work: ${extra.electrical}`,
        extra.heating         && `Heating: ${extra.heating}`,
        extra.plumbing        && `Plumbing: ${extra.plumbing}`,
        extra.windows         && `Windows: ${extra.windows}`,
        extra.structural      && `Structural: ${extra.structural}`,
        extra.externalWorks   && `External works: ${extra.externalWorks}`,
      ].filter(Boolean).join('\n');
    } else {
      extraDetails = [
        extra.propertyAge       && `Property age: ${extra.propertyAge}`,
        extra.groundConditions  && `Ground conditions: ${extra.groundConditions}`,
        extra.planningSituation && `Planning: ${extra.planningSituation}`,
        extra.siteAccess        && `Site access: ${extra.siteAccess}`,
        extra.partyWall         && `Party wall: ${extra.partyWall}`,
        extra.glazingSpec       && `Glazing: ${extra.glazingSpec}`,
        extra.interiorFinish    && `Interior finish: ${extra.interiorFinish}`,
      ].filter(Boolean).join('\n');
    }
  }

  const systemPrompt = `You are a Principal Designer (Building Regulations) specialising in UK residential renovation and extension projects. You write clear, specific, professional Intelligence Reports for homeowners. Write in British English. Be direct and actionable — never generic. Every statement should reflect the specific details provided.`;

  const userPrompt = `Generate a full Intelligence Report for this homeowner project. Output ONLY valid JSON — no markdown, no backticks, no preamble.

PROJECT DETAILS:
Type: ${isReno ? 'Renovation' : 'Extension'}
Region: ${estimate.region || '—'}
Property type: ${estimate.propertyType || '—'}
${isReno ? `Bedrooms: ${estimate.bedrooms || '—'}
Property age: ${estimate.age || '—'}
Renovation level: ${estimate.levelOrType || '—'}` : `Extension type: ${estimate.levelOrType || '—'}`}
Specification: ${estimate.spec || '—'}
Estimate range: ${estimate.estimateLow || '—'} – ${estimate.estimateHigh || '—'}

ADDITIONAL DETAILS:
${extraDetails || 'None provided'}

Output this exact JSON structure:
{
  "executiveSummary": "3-4 paragraph plain English overview specific to their project. Mention their region, property type, and scope specifically.",
  "costBreakdown": [
    {"item": "Item name", "low": "£XX,000", "high": "£XX,000", "notes": "Brief explanation of this cost driver"}
  ],
  "regionalContext": "2-3 paragraphs on what drives costs in their specific region and how it compares to the national average.",
  "riskFactors": [
    {"risk": "Risk name", "likelihood": "Low/Medium/High", "impact": "£X,000–£X,000", "mitigation": "Specific action to take"}
  ],
  "hiddenCosts": [
    {"item": "Hidden cost item", "estimate": "£X,000–£X,000", "explanation": "Why this is often missed and when it applies"}
  ],
  "contingencyGuidance": "Specific paragraph recommending contingency % for their project profile and explaining why, with a worked example using their estimate figures.",
  "projectTimeline": [
    {"phase": "Phase name", "duration": "X weeks", "description": "What happens and key decisions needed"}
  ],
  "contractorChecklist": ["Specific question or requirement to include in contractor briefings"],
  "nextSteps": ["Specific sequenced action item"]
}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.4,
    max_tokens: 4000,
  });

  const raw = response.choices[0].message.content.trim();
  // Strip any accidental markdown fences
  const cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(cleaned);
}

// ── PDF GENERATION ────────────────────────────────────────────

async function generatePDF(report, estimate, tool) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: 50, compress: true });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end',  ()    => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const NAVY  = '#0d1117';
    const TEAL  = '#4fc3c3';
    const CARD  = '#151c26';
    const MUTED = '#8a97aa';
    const WHITE = '#ffffff';
    const LIGHT = '#e8edf4';
    const W     = 595 - 100; // page width minus margins

    const isReno = tool === 'renovation';
    const toolLabel = isReno ? 'Renovation' : 'Extension';

    // ── PAGE 1: COVER ──────────────────────────────────────
    doc.rect(0, 0, 595, 842).fill(NAVY);

    // Teal top bar
    doc.rect(0, 0, 595, 5).fill(TEAL);

    // Logo area
    doc.fontSize(22).font('Helvetica-Bold').fillColor(WHITE)
       .text('UrbanBrief', 50, 60);
    doc.fontSize(9).font('Helvetica').fillColor(MUTED)
       .text('Renovation Intelligence', 50, 88);

    // Report title
    doc.moveDown(4);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(TEAL)
       .text('INTELLIGENCE REPORT', 50, 160, { characterSpacing: 2 });
    doc.fontSize(28).font('Helvetica-Bold').fillColor(WHITE)
       .text(`${toolLabel} Cost\nIntelligence Report`, 50, 182, { lineGap: 6 });

    // Estimate band
    doc.roundedRect(50, 280, W, 80, 8).fill(CARD);
    doc.rect(50, 280, 4, 80).fill(TEAL);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(MUTED)
       .text('ESTIMATED COST RANGE', 66, 296, { characterSpacing: 1 });
    doc.fontSize(26).font('Helvetica-Bold').fillColor(TEAL)
       .text(`${estimate.estimateLow || '—'} – ${estimate.estimateHigh || '—'}`, 66, 314);
    doc.fontSize(9).font('Helvetica').fillColor(MUTED)
       .text(`${estimate.region || ''} · ${estimate.propertyType || ''} · ${estimate.spec || ''} spec`, 66, 346);

    // Details grid
    const details = isReno
      ? [['Property type', estimate.propertyType || '—'], ['Region', (estimate.region || '—').replace(/_/g, ' ')],
         ['Scope', estimate.levelOrType || '—'], ['Specification', estimate.spec || '—'],
         ['Property age', estimate.age || '—'], ['Bedrooms', estimate.bedrooms || '—']]
      : [['Extension type', estimate.levelOrType || '—'], ['Region', (estimate.region || '—').replace(/_/g, ' ')],
         ['Specification', estimate.spec || '—'], ['Report date', new Date().toLocaleDateString('en-GB')]];

    let gx = 50, gy = 390;
    details.forEach(([label, val], i) => {
      if (i % 2 === 0 && i > 0) { gy += 52; gx = 50; }
      const cx = gx + (i % 2) * (W / 2 + 8);
      doc.roundedRect(cx, gy, W / 2 - 4, 44, 6).fill(CARD);
      doc.fontSize(7).font('Helvetica-Bold').fillColor(MUTED)
         .text(label.toUpperCase(), cx + 12, gy + 10, { characterSpacing: 0.8 });
      doc.fontSize(11).font('Helvetica-Bold').fillColor(LIGHT)
         .text(val, cx + 12, gy + 22);
    });

    // Footer
    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
       .text('This report is for guidance only. Always obtain 3+ professional quotes before committing.', 50, 780, { align: 'center', width: W });
    doc.fontSize(8).fillColor(MUTED)
       .text(`urbanbrief.co.uk  ·  enquiries@urbanbrief.co.uk  ·  Generated ${new Date().toLocaleDateString('en-GB')}`, 50, 795, { align: 'center', width: W });

    // ── PAGE 2: EXECUTIVE SUMMARY + COST BREAKDOWN ─────────
    doc.addPage();
    doc.rect(0, 0, 595, 842).fill(NAVY);
    doc.rect(0, 0, 595, 4).fill(TEAL);

    let y = 50;

    function sectionTitle(title) {
      doc.fontSize(7).font('Helvetica-Bold').fillColor(TEAL)
         .text(title.toUpperCase(), 50, y, { characterSpacing: 1.5 });
      y += 18;
      doc.rect(50, y, W, 0.5).fill(CARD);
      y += 10;
    }

    function bodyText(text, indent = 0) {
      doc.fontSize(9.5).font('Helvetica').fillColor(MUTED)
         .text(text, 50 + indent, y, { width: W - indent, lineGap: 3 });
      y += doc.heightOfString(text, { width: W - indent, lineGap: 3 }) + 10;
    }

    function heading(text) {
      doc.fontSize(16).font('Helvetica-Bold').fillColor(WHITE)
         .text(text, 50, y);
      y += 28;
    }

    function checkPage(needed = 80) {
      if (y + needed > 800) { doc.addPage(); doc.rect(0,0,595,842).fill(NAVY); doc.rect(0,0,595,4).fill(TEAL); y = 50; }
    }

    heading('Executive Summary');
    sectionTitle('Overview');
    bodyText(report.executiveSummary || '');

    checkPage(100);
    heading('Cost Breakdown');
    sectionTitle('Itemised estimate');

    if (Array.isArray(report.costBreakdown)) {
      report.costBreakdown.forEach(item => {
        checkPage(60);
        doc.roundedRect(50, y, W, 48, 6).fill(CARD);
        doc.fontSize(10).font('Helvetica-Bold').fillColor(LIGHT)
           .text(item.item || '', 62, y + 8, { width: W - 150 });
        doc.fontSize(10).font('Helvetica-Bold').fillColor(TEAL)
           .text(`${item.low || ''} – ${item.high || ''}`, 62 + (W - 150), y + 8, { width: 130, align: 'right' });
        doc.fontSize(8.5).font('Helvetica').fillColor(MUTED)
           .text(item.notes || '', 62, y + 26, { width: W - 24 });
        y += 56;
      });
    }

    // ── PAGE 3: RISKS + HIDDEN COSTS ───────────────────────
    checkPage(100);
    heading('Risk Factors');
    sectionTitle('Project-specific risks');

    if (Array.isArray(report.riskFactors)) {
      report.riskFactors.forEach(risk => {
        checkPage(80);
        const likeColour = risk.likelihood === 'High' ? '#e05252' : risk.likelihood === 'Medium' ? '#e8c84c' : '#4cba6e';
        doc.roundedRect(50, y, W, 64, 6).fill(CARD);
        doc.roundedRect(50, y, 4, 64, 2).fill(likeColour);
        doc.fontSize(10).font('Helvetica-Bold').fillColor(LIGHT)
           .text(risk.risk || '', 62, y + 8, { width: W - 160 });
        doc.fontSize(8).font('Helvetica-Bold').fillColor(likeColour)
           .text(`${risk.likelihood || ''} risk`, 62 + (W - 160), y + 8, { width: 120, align: 'right' });
        doc.fontSize(8.5).font('Helvetica').fillColor(MUTED)
           .text(`Impact: ${risk.impact || '—'}`, 62, y + 26);
        doc.fontSize(8.5).font('Helvetica').fillColor(MUTED)
           .text(`Mitigation: ${risk.mitigation || '—'}`, 62, y + 40, { width: W - 24 });
        y += 72;
      });
    }

    checkPage(80);
    heading('Hidden Costs');
    sectionTitle('Often missed in initial quotes');

    if (Array.isArray(report.hiddenCosts)) {
      report.hiddenCosts.forEach(cost => {
        checkPage(60);
        doc.roundedRect(50, y, W, 52, 6).fill(CARD);
        doc.fontSize(10).font('Helvetica-Bold').fillColor(LIGHT)
           .text(cost.item || '', 62, y + 8, { width: W - 150 });
        doc.fontSize(10).font('Helvetica-Bold').fillColor(TEAL)
           .text(cost.estimate || '', 62 + (W - 150), y + 8, { width: 130, align: 'right' });
        doc.fontSize(8.5).font('Helvetica').fillColor(MUTED)
           .text(cost.explanation || '', 62, y + 26, { width: W - 24 });
        y += 60;
      });
    }

    // ── PAGE 4: TIMELINE + CONTINGENCY + CHECKLIST ─────────
    checkPage(80);
    heading('Project Timeline');
    sectionTitle('Realistic phases for your scope');

    if (Array.isArray(report.projectTimeline)) {
      report.projectTimeline.forEach((phase, i) => {
        checkPage(60);
        doc.roundedRect(50, y, W, 52, 6).fill(CARD);
        doc.circle(66, y + 16, 8).fill(TEAL);
        doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY)
           .text(String(i + 1), 63, y + 11);
        doc.fontSize(10).font('Helvetica-Bold').fillColor(LIGHT)
           .text(phase.phase || '', 82, y + 8, { width: W - 100 });
        doc.fontSize(8.5).font('Helvetica-Bold').fillColor(TEAL)
           .text(phase.duration || '', 82 + (W - 100), y + 8, { width: 80, align: 'right' });
        doc.fontSize(8.5).font('Helvetica').fillColor(MUTED)
           .text(phase.description || '', 82, y + 26, { width: W - 40 });
        y += 60;
      });
    }

    checkPage(80);
    heading('Contingency Guidance');
    sectionTitle('Risk-adjusted buffer recommendation');
    bodyText(report.contingencyGuidance || '');

    checkPage(80);
    heading('Contractor Briefing Checklist');
    sectionTitle('What to require from every quote');

    if (Array.isArray(report.contractorChecklist)) {
      report.contractorChecklist.forEach(item => {
        checkPage(30);
        doc.fontSize(9.5).font('Helvetica').fillColor(TEAL).text('✓', 50, y);
        doc.fontSize(9.5).font('Helvetica').fillColor(MUTED)
           .text(item, 66, y, { width: W - 16 });
        y += doc.heightOfString(item, { width: W - 16 }) + 8;
      });
    }

    checkPage(80);
    heading('Next Steps');
    sectionTitle('Recommended sequence of actions');

    if (Array.isArray(report.nextSteps)) {
      report.nextSteps.forEach((step, i) => {
        checkPage(30);
        doc.roundedRect(50, y, 20, 20, 4).fill(TEAL);
        doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY)
           .text(String(i + 1), 55, y + 5);
        doc.fontSize(9.5).font('Helvetica').fillColor(MUTED)
           .text(step, 78, y + 4, { width: W - 28 });
        y += doc.heightOfString(step, { width: W - 28 }) + 14;
      });
    }

    // ── FINAL PAGE: REGIONAL CONTEXT + DISCLAIMER ──────────
    checkPage(80);
    heading('Regional Market Context');
    sectionTitle(`Cost drivers in ${(estimate.region || 'your area').replace(/_/g, ' ')}`);
    bodyText(report.regionalContext || '');

    checkPage(120);
    doc.roundedRect(50, y, W, 100, 8).fill(CARD);
    doc.rect(50, y, 4, 100).fill(TEAL);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(WHITE)
       .text('Important Disclaimer', 66, y + 12);
    doc.fontSize(8.5).font('Helvetica').fillColor(MUTED)
       .text(
         'This Intelligence Report provides indicative cost estimates based on UK market data and the information you supplied. Actual costs vary significantly depending on contractor, site conditions, material prices and unforeseen issues. This report does not constitute professional advice and should not be relied upon as the sole basis for financial decisions. Always obtain a minimum of three competitive quotes from qualified contractors before committing to any works.',
         66, y + 30, { width: W - 32, lineGap: 3 }
       );

    y += 120;
    checkPage(60);
    doc.fontSize(8).font('Helvetica').fillColor(MUTED)
       .text('UrbanBrief  ·  Principal Designer (Building Regulations)  ·  urbanbrief.co.uk  ·  enquiries@urbanbrief.co.uk', 50, y, { align: 'center', width: W });

    doc.end();
  });
}

// ── EMAIL DELIVERY ────────────────────────────────────────────

async function sendReportEmail(email, pdfBuffer, tool, report, estimate) {
  const toolLabel  = tool === 'renovation' ? 'Renovation' : 'Extension';
  const pdfBase64  = pdfBuffer.toString('base64');
  const summary    = (report.executiveSummary || '').substring(0, 300) + '…';

  const htmlBody = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

<tr><td style="background:#151c26;border-radius:14px 14px 0 0;padding:28px 32px;border-bottom:1px solid rgba(255,255,255,0.09);">
<span style="font-size:18px;font-weight:700;color:#ffffff;">UrbanBrief</span>
<span style="font-size:11px;font-weight:500;color:#556070;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);border-radius:20px;padding:3px 10px;margin-left:10px;letter-spacing:0.1em;text-transform:uppercase;">Intelligence Report</span>
</td></tr>

<tr><td style="background:#151c26;padding:32px 32px 0;">
<p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#4fc3c3;letter-spacing:0.14em;text-transform:uppercase;">Your report is attached</p>
<p style="margin:0 0 20px;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">Your ${toolLabel} Intelligence Report</p>
<div style="background:#1a2235;border:1px solid rgba(79,195,195,0.2);border-radius:12px;padding:24px;margin-bottom:20px;">
<p style="margin:0 0 6px;font-size:10px;font-weight:600;color:#556070;letter-spacing:0.12em;text-transform:uppercase;">Estimate range</p>
<p style="margin:0 0 4px;font-size:28px;font-weight:700;color:#4fc3c3;letter-spacing:-0.02em;">${estimate.estimateLow || '—'} – ${estimate.estimateHigh || '—'}</p>
<p style="margin:0;font-size:12px;color:#8a97aa;">${(estimate.region || '').replace(/_/g, ' ')} · ${estimate.propertyType || ''} · ${estimate.spec || ''} spec</p>
</div>
<p style="margin:0 0 20px;font-size:14px;color:#8a97aa;line-height:1.7;">${summary}</p>
</td></tr>

<tr><td style="background:#151c26;padding:0 32px 32px;">
<div style="background:#1a2235;border:1px solid rgba(79,195,195,0.2);border-radius:10px;padding:20px;text-align:center;">
<p style="margin:0 0 12px;font-size:13px;color:#8a97aa;">Your full report is attached as a PDF. It includes a detailed cost breakdown, risk factors, hidden costs, contingency guidance and a realistic project timeline.</p>
<a href="https://urbanbrief.co.uk" style="display:inline-block;background:#4fc3c3;color:#0d1117;font-size:14px;font-weight:700;padding:11px 28px;border-radius:7px;text-decoration:none;">Visit UrbanBrief →</a>
</div>
</td></tr>

<tr><td style="background:#151c26;border-radius:0 0 14px 14px;border-top:1px solid rgba(255,255,255,0.09);padding:20px 32px;text-align:center;">
<p style="margin:0;font-size:12px;color:#556070;">© 2025 UrbanBrief · <a href="https://urbanbrief.co.uk" style="color:#4fc3c3;text-decoration:none;">urbanbrief.co.uk</a> · enquiries@urbanbrief.co.uk</p>
</td></tr>

</table></td></tr></table>
</body></html>`;

  await resend.emails.send({
    from:        process.env.FROM_EMAIL || 'noreply@urbanbrief.co.uk',
    to:          email,
    replyTo:     'enquiries@urbanbrief.co.uk',
    subject:     `Your UrbanBrief ${toolLabel} Intelligence Report`,
    html:        htmlBody,
    attachments: [{
      filename:    'UrbanBrief-Intelligence-Report.pdf',
      content:     pdfBase64,
    }],
  });
}

// ── RAW BODY HELPER (needed for Stripe signature) ─────────────

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end',  ()    => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
