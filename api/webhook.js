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
    const pdfBuffer = await generatePDF(reportContent, estimate, tool);
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

// ── PDF ───────────────────────────────────────────────────────

async function generatePDF(report, estimate, tool) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, compress: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const NAVY='#0d1117',TEAL='#4fc3c3',CARD='#151c26',MUTED='#8a97aa',WHITE='#ffffff',LIGHT='#e8edf4',W=495;
    const isReno = tool==='renovation', label = isReno?'Renovation':'Extension';
    const estLow=get(estimate,'Estimate Low','estimateLow'), estHigh=get(estimate,'Estimate High','estimateHigh');
    const region=(get(estimate,'Region','region')+'').replace(/_/g,' ');
    const propType=get(estimate,'Property Type','propertyType'), spec=get(estimate,'Spec','spec');

    // Cover
    doc.rect(0,0,595,842).fill(NAVY);
    doc.rect(0,0,595,5).fill(TEAL);
    doc.fontSize(22).font('Helvetica-Bold').fillColor(WHITE).text('UrbanBrief',50,60);
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('Renovation Intelligence',50,88);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(TEAL).text('INTELLIGENCE REPORT',50,160,{characterSpacing:2});
    doc.fontSize(28).font('Helvetica-Bold').fillColor(WHITE).text(`${label} Cost\nIntelligence Report`,50,182,{lineGap:6});
    doc.roundedRect(50,280,W,80,8).fill(CARD);
    doc.rect(50,280,4,80).fill(TEAL);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(MUTED).text('ESTIMATED COST RANGE',66,296,{characterSpacing:1});
    doc.fontSize(26).font('Helvetica-Bold').fillColor(TEAL).text(`${estLow} – ${estHigh}`,66,314);
    doc.fontSize(9).font('Helvetica').fillColor(MUTED).text(`${region} · ${propType} · ${spec} spec`,66,346);

    let y=50;
    function np(){doc.addPage();doc.rect(0,0,595,842).fill(NAVY);doc.rect(0,0,595,4).fill(TEAL);y=50;}
    function chk(n=80){if(y+n>800)np();}
    function hd(t){chk(50);doc.fontSize(16).font('Helvetica-Bold').fillColor(WHITE).text(t,50,y);y+=28;doc.rect(50,y,W,.5).fill(CARD);y+=10;}
    function bd(t){chk(60);doc.fontSize(9.5).font('Helvetica').fillColor(MUTED).text(t,50,y,{width:W,lineGap:3});y+=doc.heightOfString(t,{width:W,lineGap:3})+10;}

    np();
    hd('Executive Summary'); bd(report.executiveSummary||'');
    hd('Cost Breakdown');
    (report.costBreakdown||[]).forEach(i=>{chk(60);doc.roundedRect(50,y,W,48,6).fill(CARD);doc.fontSize(10).font('Helvetica-Bold').fillColor(LIGHT).text(i.item||'',62,y+8,{width:W-150});doc.fontSize(10).font('Helvetica-Bold').fillColor(TEAL).text(`${i.low||''} – ${i.high||''}`,62+W-150,y+8,{width:130,align:'right'});doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text(i.notes||'',62,y+26,{width:W-24});y+=56;});
    hd('Risk Factors');
    (report.riskFactors||[]).forEach(r=>{chk(80);const c=r.likelihood==='High'?'#e05252':r.likelihood==='Medium'?'#e8c84c':'#4cba6e';doc.roundedRect(50,y,W,64,6).fill(CARD);doc.roundedRect(50,y,4,64,2).fill(c);doc.fontSize(10).font('Helvetica-Bold').fillColor(LIGHT).text(r.risk||'',62,y+8,{width:W-160});doc.fontSize(8).font('Helvetica-Bold').fillColor(c).text((r.likelihood||'')+' risk',62+W-160,y+8,{width:120,align:'right'});doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text('Impact: '+(r.impact||'—'),62,y+26);doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text('Mitigation: '+(r.mitigation||'—'),62,y+40,{width:W-24});y+=72;});
    hd('Hidden Costs');
    (report.hiddenCosts||[]).forEach(c=>{chk(60);doc.roundedRect(50,y,W,52,6).fill(CARD);doc.fontSize(10).font('Helvetica-Bold').fillColor(LIGHT).text(c.item||'',62,y+8,{width:W-150});doc.fontSize(10).font('Helvetica-Bold').fillColor(TEAL).text(c.estimate||'',62+W-150,y+8,{width:130,align:'right'});doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text(c.explanation||'',62,y+26,{width:W-24});y+=60;});
    hd('Contingency Guidance'); bd(report.contingencyGuidance||'');
    hd('Project Timeline');
    (report.projectTimeline||[]).forEach((p,i)=>{chk(60);doc.roundedRect(50,y,W,52,6).fill(CARD);doc.circle(66,y+16,8).fill(TEAL);doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY).text(String(i+1),63,y+11);doc.fontSize(10).font('Helvetica-Bold').fillColor(LIGHT).text(p.phase||'',82,y+8,{width:W-100});doc.fontSize(8.5).font('Helvetica-Bold').fillColor(TEAL).text(p.duration||'',82+W-100,y+8,{width:80,align:'right'});doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text(p.description||'',82,y+26,{width:W-40});y+=60;});
    hd('Contractor Checklist');
    (report.contractorChecklist||[]).forEach(i=>{chk(30);doc.fontSize(9.5).font('Helvetica').fillColor(TEAL).text('✓',50,y);doc.fontSize(9.5).font('Helvetica').fillColor(MUTED).text(i,66,y,{width:W-16});y+=doc.heightOfString(i,{width:W-16})+8;});
    hd('Next Steps');
    (report.nextSteps||[]).forEach((s,i)=>{chk(30);doc.roundedRect(50,y,20,20,4).fill(TEAL);doc.fontSize(9).font('Helvetica-Bold').fillColor(NAVY).text(String(i+1),55,y+5);doc.fontSize(9.5).font('Helvetica').fillColor(MUTED).text(s,78,y+4,{width:W-28});y+=doc.heightOfString(s,{width:W-28})+14;});
    hd('Regional Context'); bd(report.regionalContext||'');

    chk(120);
    doc.roundedRect(50,y,W,100,8).fill(CARD);doc.rect(50,y,4,100).fill(TEAL);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(WHITE).text('Important Disclaimer',66,y+12);
    doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text('Indicative estimates only based on UK market data. Always obtain 3+ competitive quotes from qualified contractors before committing to any works.',66,y+30,{width:W-32,lineGap:3});
    y+=120;
    chk(40);
    doc.fontSize(8).font('Helvetica').fillColor(MUTED).text('UrbanBrief · urbanbrief.co.uk · enquiries@urbanbrief.co.uk',50,y,{align:'center',width:W});
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
