// Automation Readiness Assessment handler: validates the 9-question +
// free-text submission, scores it (0-18), calls Grok (xAI) for a
// personalised result, emails that result to the prospect via Resend,
// logs the full completion durably (same GitHub-append pattern as
// api/hit.js / api/cohort.js), and returns { score, tier, html } to the
// client for on-page rendering.
//
// POST body: {
//   answers: number[9] (each 0/1/2),
//   task: string (1-500 chars, required),
//   trade: string, email: string, teamSize: string,
//   utm: { source, medium, campaign, ... } (optional passthrough, strings only),
//   paid_session: string (optional; Stripe session_id passthrough)
// }
//
// Env vars required:
//   XAI_API_KEY      - xAI (Grok) API key
//   RESEND_API_KEY    - Resend API key
//   HIT_GH_TOKEN      - GitHub token with repo contents:write (reused from hit.js)
//   HIT_GH_REPO       - "Kynetica/kynetica-hits" (reused)
//   ASSESS_GH_PATH    - "assess/completions.jsonl" (defaults to that)

const TRADES = new Set(['HVAC', 'Plumbing', 'Electrical', 'Dental', 'Landscaping', 'Agency', 'Other']);
const TEAM_SIZES = new Set(['1-2', '3-9', '10-25', '25+']);
const STRIPE_LINK = 'https://buy.stripe.com/aFa14o3QNc571rR4yzbo400';

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const e = email.trim();
  if (e.length < 5 || e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function clean(v, max) {
  return (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function scoreAnswers(answers) {
  if (!Array.isArray(answers) || answers.length !== 9) return null;
  let total = 0;
  for (const a of answers) {
    const n = Number(a);
    if (!Number.isInteger(n) || n < 0 || n > 2) return null;
    total += n;
  }
  return total;
}

function tierFor(score) {
  if (score <= 6) return 'flying-blind';
  if (score <= 12) return 'aware-but-leaking';
  return 'ready-to-automate';
}

const TIER_LABEL = {
  'flying-blind': 'Flying Blind',
  'aware-but-leaking': 'Aware but Leaking',
  'ready-to-automate': 'Ready to Automate',
};

function fallbackResult(score, tier, task, trade) {
  const label = TIER_LABEL[tier];
  const bodies = {
    'flying-blind': `You're running the business by feel right now: most of your week gets decided by whatever's loudest, not by a system. That's normal at this stage; it's also exactly why hours disappear without a clear explanation.`,
    'aware-but-leaking': `You can see where the time goes, but a chunk of it is still being spent twice: retyping something you already typed, re-checking something you already checked, chasing a reply that should have arrived on its own.`,
    'ready-to-automate': `You already track your time and your tools well enough to know where the friction is. The gap now isn't awareness. It's that the fixing hasn't happened yet, even though the pieces you'd need are probably already in your account.`,
  };
  const taskLine = task
    ? `You told us the task that eats your week is: "${task}". That's a concrete, recurring task, which usually means it's automatable with the tools you already have, once it's mapped out step by step.`
    : `You didn't name a specific task, which itself is worth noticing: it's hard to fix a leak you haven't pinned down yet.`;
  const html = [
    `<p><strong>${escapeHtml(label)} (${score}/18)</strong></p>`,
    `<p>${escapeHtml(bodies[tier])}</p>`,
    `<p><strong>Your biggest leak.</strong> ${escapeHtml(taskLine)} A rough estimate: tasks like this often run 2-6 hours a week depending on volume. That's an estimate, not a measurement of your business specifically.</p>`,
    `<p><strong>Next step.</strong> Write down, in order, every click and message that task takes you from start to finish. That list is the map an automation would follow.</p>`,
    `<p>Daniel Kane, Kynetica (AI)</p>`,
  ].join('\n');
  return html;
}

function paidFallbackResult(score, tier, task, trade) {
  const base = fallbackResult(score, tier, task, trade).replace(
    '<p>Daniel Kane, Kynetica (AI)</p>',
    `<p>Your paid Leak Finder breakdown couldn't be generated automatically. Sorry about that. Daniel will personally put together your full breakdown and email it to you within 24 hours.</p>\n<p>Daniel Kane, Kynetica (AI)</p>`
  );
  return base;
}

async function verifyStripeSession(sessionId) {
  if (!sessionId) return { paid: false };
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return { paid: false, reason: 'no_key' };

  try {
    const resp = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: 'Basic ' + Buffer.from(`${key}:`).toString('base64') } }
    );
    if (!resp.ok) return { paid: false, reason: `stripe_${resp.status}` };
    const session = await resp.json();
    const paid = session.payment_status === 'paid' && (session.amount_total || 0) >= 700;
    return {
      paid,
      email: session.customer_details?.email ?? null,
      amount: session.amount_total ?? null,
    };
  } catch (e) {
    return { paid: false, reason: 'exception' };
  }
}

async function callGrok(score, tier, task, trade, teamSize, paid) {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error('no_key');

  const baseRules = `HARD RULES — follow all of them exactly:
- No invented statistics. No customer counts, testimonials, or claims of past results anywhere.
- No promises of results ("this will save you X hours") — only clearly-labelled estimates, and only if you label them as estimates.
- Plain, direct language. No jargon, no buzzwords, no exclamation points, no emoji.
- Never mention any AI model or provider name (not "GPT", "Grok", "xAI", "Claude", "trained on", etc.).
- Sign off exactly as: "Daniel Kane, Kynetica (AI)"
- Output plain HTML using only <p> and <strong> tags. No markdown, no headings, no lists, no links, no scripts.`;

  const systemPrompt = paid ? `You write short, personalised results for a paid ($7) "Automation Leak Finder" variant of a 9-question "Automation Readiness Assessment" taken by owners of small service businesses (HVAC, plumbing, electrical, dental, landscaping, agencies). You are writing as Daniel Kane, the AI that runs Kynetica.

${baseRules}
- Total length: the standard section (180-250 words) PLUS a second section (380-500 words) headed exactly "Your Leak Finder breakdown".
- Standard section structure exactly: (1) a short behavioural portrait paragraph matching their tier — write as if describing THEM specifically, not a generic score band; (2) a paragraph headed "Your biggest leak" that addresses THEIR free-text task specifically, names one concrete automation approach using tools a small business like theirs plausibly already owns (email, calendar, spreadsheets, their booking/CRM software, Zapier/Make-style connectors), and gives one rough hours/week estimate CLEARLY labelled as an estimate/guess, not a fact; (3) exactly ONE next step, one sentence, concrete and doable this week without buying anything.
- The "Your Leak Finder breakdown" section must, in order: (a) decompose their named task into its concrete steps; (b) state which of those steps are automatable and, for each, the CATEGORY of tool they plausibly already own that could do it (email, calendar, spreadsheet, booking/CRM software, Zapier/Make-style connector) — never a specific named product/model; (c) give a rough setup-effort estimate in hours, clearly labelled as an estimate; (d) give a rough weekly-hours-recovered range, clearly labelled as an estimate, not a promise; (e) name two more secondary leaks inferred from their 9 answers (not the named task), each one sentence.
- Sign off ONCE at the very end of the whole output (not after each section).` : `You write short, personalised results for a free 9-question "Automation Readiness Assessment" taken by owners of small service businesses (HVAC, plumbing, electrical, dental, landscaping, agencies). You are writing as Daniel Kane, the AI that runs Kynetica.

${baseRules}
- 180-250 words total.
- Structure exactly: (1) a short behavioural portrait paragraph matching their tier — write as if describing THEM specifically, not a generic score band; (2) a paragraph headed "Your biggest leak" that addresses THEIR free-text task specifically, names one concrete automation approach using tools a small business like theirs plausibly already owns (email, calendar, spreadsheets, their booking/CRM software, Zapier/Make-style connectors), and gives one rough hours/week estimate CLEARLY labelled as an estimate/guess, not a fact; (3) exactly ONE next step, one sentence, concrete and doable this week without buying anything.`;

  const answersNote = paid ? ' They have paid for the Leak Finder breakdown; use all 9 answer values plus their team size and trade to infer two secondary leaks beyond the named task.' : '';
  const userPrompt = `Score: ${score}/18. Tier: ${TIER_LABEL[tier]}. Trade: ${trade || 'not given'}. Team size: ${teamSize || 'not given'}. Their described task that eats their week: "${task}".${answersNote}`;

  const models = ['grok-4-fast', 'grok-3-mini'];
  let lastErr;
  for (const model of models) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.6,
          max_tokens: 700,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) { lastErr = new Error(`xai_${resp.status}`); continue; }
      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim().length > 40) {
        return text.trim();
      }
      lastErr = new Error('xai_empty');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('xai_failed');
}

async function appendCompletionLine(line) {
  const token = process.env.HIT_GH_TOKEN;
  const repo = process.env.HIT_GH_REPO;
  const filePath = process.env.ASSESS_GH_PATH || 'assess/completions.jsonl';
  if (!token || !repo) return { stored: false, reason: 'gh_not_configured' };
  const apiBase = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'kynetica-assess',
    Accept: 'application/vnd.github+json',
  };
  const getResp = await fetch(apiBase, { headers });
  let sha, existing = '';
  if (getResp.ok) {
    const data = await getResp.json();
    sha = data.sha;
    existing = Buffer.from(data.content, 'base64').toString('utf8');
  } else if (getResp.status !== 404) {
    return { stored: false, reason: `gh_get_${getResp.status}` };
  }
  const updated = existing + line;
  const body = {
    message: `assess completion ${new Date().toISOString()}`,
    content: Buffer.from(updated).toString('base64'),
    ...(sha ? { sha } : {}),
  };
  const putResp = await fetch(apiBase, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!putResp.ok) return { stored: false, reason: `gh_put_${putResp.status}` };
  return { stored: true };
}

async function emailResult(record, resultHtml) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'resend_not_configured' };

  const stripeUrl = `${STRIPE_LINK}?client_reference_id=assess-${record.score}`;
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;color:#1a1d24;line-height:1.6">
    <h2 style="margin:0 0 8px">Your Automation Readiness result: ${record.score}/18</h2>
    <p style="color:#555;margin:0 0 20px">Tier: ${escapeHtml(TIER_LABEL[record.tier])}</p>
    <div>${resultHtml}</div>
    <div style="margin:28px 0;padding:20px;background:#f5f7fa;border-radius:10px">
      <p style="margin:0 0 12px;font-weight:700">We'll find at least $1,000 a year in recoverable time and cost in your business, or the audit is free.</p>
      <p style="margin:0 0 16px;color:#555">The assessment guessed from nine answers. The audit reads your actual website, booking flow and back-office, and prices every leak it finds.</p>
      <a href="${stripeUrl}" style="display:inline-block;background:#111;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:700">Order the $249 Automation Audit</a>
      <p style="margin:12px 0 0;color:#777;font-size:14px">Delivered by email within 48 hours.</p>
    </div>
    <p style="color:#999;font-size:12px;margin-top:32px">
      This result was generated by AI (Daniel Kane, Kynetica) based only on the answers you gave. No claims of past results, testimonials, or guaranteed savings are made here.<br>
      Kynetica LLC · 1110 Brickell Avenue, Suite 400 #K381, Miami, FL 33131<br>
      <a href="mailto:info@kynetica.one?subject=unsubscribe">Unsubscribe</a>
    </p>
  </div>`;

  const subject = record.paid
    ? `Your Automation Leak Finder breakdown: ${record.score}/18`
    : `Your Automation Readiness result: ${record.score}/18`;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Daniel Kane <daniel@mail.kynetica.one>',
      to: [record.email],
      reply_to: ['info@kynetica.one'],
      subject,
      html,
    }),
  });
  if (!resp.ok) return { sent: false, reason: `resend_${resp.status}` };
  return { sent: true };
}

async function notifyOwner(record) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'resend_not_configured' };
  const lines = [
    `New assessment completion — score ${record.score}/18 (${TIER_LABEL[record.tier]})`,
    '',
    `Email: ${record.email}`,
    `Trade: ${record.trade || '(none)'}`,
    `Team size: ${record.teamSize || '(none)'}`,
    `Answers: ${JSON.stringify(record.answers)}`,
    `Task that eats their week: ${record.task}`,
    `UTM: ${JSON.stringify(record.utm || {})}`,
    `Paid session: ${record.paid_session || '(none)'}`,
    `Paid (verified): ${record.paid ? 'YES' : 'no'}`,
    record.needs_manual ? '*** NEEDS MANUAL FOLLOW-UP: paid Leak Finder breakdown generation failed, apology fallback sent — Daniel must email full breakdown within 24h ***' : '',
    `Submitted: ${record.ts}`,
  ].filter(Boolean);
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Kynetica Assessments <daniel@mail.kynetica.one>',
      to: ['info@kynetica.one'],
      reply_to: [record.email],
      subject: `Assessment: ${record.score}/18 — ${record.trade || 'unknown trade'}`,
      text: lines.join('\n'),
    }),
  });
  if (!resp.ok) return { sent: false, reason: `resend_${resp.status}` };
  return { sent: true };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const score = scoreAnswers(body.answers);
  const task = clean(body.task, 500);
  const email = clean(body.email, 254);
  let trade = clean(body.trade, 20);
  let teamSize = clean(body.teamSize, 10);
  const paid_session = clean(body.paid_session, 300);
  const utmRaw = body.utm || {};
  const utm = {};
  for (const k of Object.keys(utmRaw)) {
    if (/^utm_/.test(k)) utm[k] = clean(utmRaw[k], 200);
  }

  if (!TRADES.has(trade)) trade = 'Other';
  if (!TEAM_SIZES.has(teamSize)) teamSize = '';

  if (score === null || !task || task.length < 1 || !isValidEmail(email)) {
    res.status(400).json({ error: 'invalid_submission' });
    return;
  }

  const tier = tierFor(score);

  let paid = false;
  let stripeEmail = null;
  if (paid_session) {
    try {
      const verify = await verifyStripeSession(paid_session);
      paid = !!verify.paid;
      stripeEmail = verify.email || null;
    } catch (e) {
      paid = false;
    }
  }

  const record = {
    ts: new Date().toISOString(),
    score, tier, task, trade, teamSize, email,
    answers: body.answers,
    utm, paid_session,
    paid, stripe_email: stripeEmail,
  };

  let resultHtml;
  let needsManual = false;
  try {
    resultHtml = await callGrok(score, tier, task, trade, teamSize, paid);
  } catch (e) {
    resultHtml = paid ? paidFallbackResult(score, tier, task, trade) : fallbackResult(score, tier, task, trade);
    if (paid) needsManual = true;
  }
  record.needs_manual = needsManual;

  let storeResult, emailR, notifyR;
  try { storeResult = await appendCompletionLine(JSON.stringify(record) + '\n'); }
  catch (e) { storeResult = { stored: false, reason: 'exception' }; }

  try { emailR = await emailResult(record, resultHtml); }
  catch (e) { emailR = { sent: false, reason: 'exception' }; }

  try { notifyR = await notifyOwner(record); }
  catch (e) { notifyR = { sent: false, reason: 'exception' }; }

  res.status(200).json({
    score, tier, html: resultHtml, paid,
    stored: storeResult.stored, emailed: emailR.sent, notified: notifyR.sent,
  });
}
