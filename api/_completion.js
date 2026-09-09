// Shared helpers for the assessment funnel: scoring, Grok prompt calls,
// GitHub-jsonl logging, email sending, and the HMAC-signed completion
// payload used to bind a Stripe Checkout Session (and email deep-links)
// to a free assessment completion WITHOUT any database. The Checkout
// Session's metadata (or a signed URL token) IS the record.
//
// Leading underscore keeps this out of Vercel's automatic /api routing;
// it's imported by api/assess.js and api/unlock.js.

import crypto from 'crypto';

export const TRADES = new Set(['HVAC', 'Plumbing', 'Electrical', 'Dental', 'Landscaping', 'Agency', 'Other']);
export const TEAM_SIZES = new Set(['1-2', '3-9', '10-25', '25+']);
export const AUDIT_STRIPE_LINK = 'https://buy.stripe.com/aFa14o3QNc571rR4yzbo400';
export const UNLOCK_PRICE_ID = 'price_1UDp6cLJjM5m13mj90TuE4uk';

export const TIER_LABEL = {
  'flying-blind': 'Flying Blind',
  'aware-but-leaking': 'Aware but Leaking',
  'ready-to-automate': 'Ready to Automate',
};

export function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const e = email.trim();
  if (e.length < 5 || e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export function clean(v, max) {
  return (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
}

export function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function scoreAnswers(answers) {
  if (!Array.isArray(answers) || answers.length !== 9) return null;
  let total = 0;
  for (const a of answers) {
    const n = Number(a);
    if (!Number.isInteger(n) || n < 0 || n > 2) return null;
    total += n;
  }
  return total;
}

export function tierFor(score) {
  if (score <= 6) return 'flying-blind';
  if (score <= 12) return 'aware-but-leaking';
  return 'ready-to-automate';
}

export function genCompletionId() {
  // 16 random bytes -> 22-char base64url string (no padding).
  return crypto.randomBytes(16).toString('base64url');
}

export function fallbackResult(score, tier, task, trade) {
  const html = [
    `<p>You told us the task eating your week is: ${escapeHtml(task)}.</p>`,
    `<p>The detailed read of that task did not complete just now. I'm not going to hand you a generic answer instead. Reply to this email and I will write it by hand and send it back.</p>`,
    `<p>Daniel Kane, Kynetica (AI)</p>`,
  ].join('\n');
  return html;
}

export function paidFallbackResult(score, tier, task, trade) {
  const base = fallbackResult(score, tier, task, trade).replace(
    '<p>Daniel Kane, Kynetica (AI)</p>',
    `<p>You paid $7 for the full breakdown and it did not generate just now. I will write it by hand and email it to you within 24 hours. If it is not in your inbox by then, reply to this email.</p>\n<p>Daniel Kane, Kynetica (AI)</p>`
  );
  return base;
}

export async function callGrok(score, tier, task, trade, teamSize, paid) {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error('no_key');

  const baseRules = `HARD RULES — follow all of them exactly:
- No invented statistics. No customer counts, testimonials, or claims of past results anywhere.
- No promises of results ("this will save you X hours") — only clearly-labelled estimates, and only if you label them as estimates.
- Plain, direct language. No jargon, no buzzwords, no exclamation points, no emoji.
- Never mention any AI model or provider name (not "GPT", "Grok", "xAI", "Claude", "trained on", etc.).
- Sign off exactly as: "Daniel Kane, Kynetica (AI)"
- Output plain HTML using only <p> and <strong> tags. No markdown, no headings, no lists, no links, no scripts.`;

  const systemPrompt = paid ? `You write short, personalised results for a paid ($7) "Automation Leak Finder" variant of a 9-question "Nine-Question Leak Trace" assessment taken by owners of small service businesses (HVAC, plumbing, electrical, dental, landscaping, agencies). You are writing as Daniel Kane, the AI that runs Kynetica.

${baseRules}
- Open the entire output by restating their described task in their own words, in one sentence, before any analysis (e.g. "You told us the task eating your week is ___.").
- Total length: the standard section (180-250 words) PLUS a second section (380-500 words) headed exactly "The full breakdown".
- Standard section structure exactly: (1) a behavioural portrait paragraph that opens on ONE concrete detail from their actual answers (a specific answer they gave, or a specific word from their task description) — never open with a category description of their tier; (2) a paragraph headed "Your biggest leak" that addresses THEIR free-text task specifically: it must reference the actual nouns/objects/tools/people named in their task description (e.g. if they wrote "paper tickets" and "invoicing software", the automation approach must name those same things, not a generic substitute), name one concrete automation approach using tools a small business like theirs plausibly already owns (email, calendar, spreadsheets, their booking/CRM software, Zapier/Make-style connectors), and give one rough hours/week estimate CLEARLY labelled as an estimate/guess, not a fact; (3) exactly ONE next step that is SPECIFIC to their named task (must contain at least one noun from their task description) and doable this week without buying anything — generic tips like "write down your process" or "map your workflow" without reference to their specific task are banned.
- The "The full breakdown" section must, in order: (a) decompose THEIR named task into its concrete steps, using the task's own nouns; (b) state which of those steps are automatable and, for each, the CATEGORY of tool they plausibly already own that could do it (email, calendar, spreadsheet, booking/CRM software, Zapier/Make-style connector) — never a specific named product/model; (c) give a rough setup-effort estimate in hours, clearly labelled as an estimate; (d) give a rough weekly-hours-recovered range, clearly labelled as an estimate, not a promise; (e) name two more secondary leaks inferred from their 9 answers (not the named task), each one sentence.
- Sign off ONCE at the very end of the whole output (not after each section).
- Keep the same plain first-person voice in the breakdown section as in the opening; no report register, no headings inside paragraphs, no lists.` : `You write short, personalised results for a free 9-question "Nine-Question Leak Trace" assessment taken by owners of small service businesses (HVAC, plumbing, electrical, dental, landscaping, agencies). You are writing as Daniel Kane, the AI that runs Kynetica.

${baseRules}
- Open the entire output by restating their described task in their own words, in one sentence, before any analysis (e.g. "You told us the task eating your week is ___.").
- 180-250 words total.
- Structure exactly: (1) a behavioural portrait paragraph that opens on ONE concrete detail from their actual answers (a specific answer they gave, or a specific word from their task description) — never open with a category description of their tier; (2) a paragraph headed "Your biggest leak" that addresses THEIR free-text task specifically: it must reference the actual nouns/objects/tools/people named in their task description (e.g. if they wrote "paper tickets" and "invoicing software", the automation approach must name those same things, not a generic substitute), name one concrete automation approach using tools a small business like theirs plausibly already owns (email, calendar, spreadsheets, their booking/CRM software, Zapier/Make-style connectors), and give one rough hours/week estimate CLEARLY labelled as an estimate/guess, not a fact; (3) exactly ONE next step that is SPECIFIC to their named task (must contain at least one noun from their task description) and doable this week without buying anything — generic tips like "write down your process" or "map your workflow" without reference to their specific task are banned.`;

  const answersNote = paid ? ' They have paid for the Leak Finder breakdown; use all 9 answer values plus their team size and trade to infer two secondary leaks beyond the named task.' : '';
  const userPrompt = `Score: ${score}/18. Tier: ${TIER_LABEL[tier]}. Trade: ${trade || 'not given'}. Team size: ${teamSize || 'not given'}. Their described task that eats their week: "${task}".${answersNote}`;

  const models = ['grok-4-fast', 'grok-3-mini'];
  let lastErr;
  for (const model of models) {
    try {
      const controller = new AbortController();
      // Paid breakdown is ~600-750 words; give it room. Function maxDuration is raised in vercel.json.
      const timer = setTimeout(() => controller.abort(), paid ? 45000 : 20000);
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: *** ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.6,
          max_tokens: paid ? 1400 : 700,
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

export async function appendCompletionLine(line) {
  const token = process.env.HIT_GH_TOKEN;
  const repo = process.env.HIT_GH_REPO;
  const filePath = process.env.ASSESS_GH_PATH || 'assess/completions.jsonl';
  if (!token || !repo) return { stored: false, reason: 'gh_not_configured' };
  const apiBase = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const headers = {
    Authorization: *** ${token}`,
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

// record.paid=false -> ctaUrl should be the $7 unlock link (signed link or
// plain /assess link). record.paid=true -> shows the $249 audit block.
export async function emailResult(record, resultHtml, ctaUrl) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'resend_not_configured' };

  let ctaBlock;
  if (record.paid) {
    ctaBlock = `
    <div style="margin:28px 0;padding:20px;background:#f5f7fa;border-radius:10px">
      <p style="margin:0 0 12px;color:#333">If you want the whole business read the same way: the Automation Audit reads your website, booking flow and back office and prices every leak it finds. Written report, 6 to 10 pages, top 5 opportunities ranked, ROI estimate each, step-by-step plan naming the tools. By email within 48 hours of checkout.</p>
      <p style="margin:0 0 16px;font-weight:700">One term, no fine print: we find at least $1,000 a year in recoverable time and cost in your business, or the audit is free. You tell us; we refund.</p>
      <form method="POST" action="https://kynetica.one/api/audit" style="margin:0">
        <input type="hidden" name="paid_session" value="${escapeHtml(record.stripe_session_id || '')}">
        <input type="hidden" name="completion_id" value="${escapeHtml(record.completion_id || '')}">
        <input type="hidden" name="score" value="${escapeHtml(record.score)}">
        <input type="hidden" name="tier" value="${escapeHtml(record.tier || '')}">
        <input type="hidden" name="task" value="${escapeHtml(record.task || '')}">
        <input type="hidden" name="trade" value="${escapeHtml(record.trade || '')}">
        <input type="hidden" name="teamSize" value="${escapeHtml(record.teamSize || '')}">
        <input type="hidden" name="email" value="${escapeHtml(record.email || '')}">
        <input type="hidden" name="answers" value="${escapeHtml(JSON.stringify(record.answers || []))}">
        <input type="hidden" name="utm" value="${escapeHtml(JSON.stringify(record.utm || {}))}">
        <button type="submit" style="display:inline-block;background:#111;color:#fff;padding:14px 22px;border-radius:8px;border:none;text-decoration:none;font-weight:700;font-size:16px;cursor:pointer;font-family:inherit">Order the $249 Automation Audit</button>
      </form>
      <p style="margin:12px 0 0;color:#777;font-size:14px">Not a call, not a demo, not a retainer. We already have your answers; you won't be asked for them again.</p>
    </div>`;
  } else {
    ctaBlock = `
    <div style="margin:28px 0;padding:20px;background:#f5f7fa;border-radius:10px">
      <p style="margin:0 0 12px;color:#333">This is saved and yours to keep.</p>
      <p style="margin:0 0 16px;color:#555">If you want the task you named worked step by step: the full breakdown lays out every step, marks which ones you can automate with what you likely already own, puts labelled estimates on setup effort and hours a week, and writes up two more things it saw in your answers.</p>
      <a href="${ctaUrl}" style="display:inline-block;background:#111;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:700">Unlock the full breakdown: $7</a>
      <p style="margin:12px 0 0;color:#777;font-size:14px">One tap. Nothing to re-enter; this link already carries your answers.</p>
    </div>`;
  }

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;color:#1a1d24;line-height:1.6">
    <h2 style="margin:0 0 20px">${record.paid ? 'Your full breakdown, written from your nine answers and the task you named' : 'Your result, written from your nine answers'}</h2>
    <div>${resultHtml}</div>
    ${ctaBlock}
    <p style="color:#999;font-size:12px;margin-top:32px">
      Written by an AI (Daniel Kane, Kynetica) from the answers you gave and nothing else. Estimates are estimates. No claims of past results or guaranteed savings are made here.<br>
      Kynetica LLC. 1110 Brickell Avenue, Suite 400 #K381, Miami, FL 33131<br>
      <a href="mailto:info@kynetica.one?subject=unsubscribe">Unsubscribe</a>
    </p>
  </div>`;

  const subject = record.paid
    ? `Your full breakdown is ready`
    : `Your result: the leak in "${record.task ? record.task.slice(0, 40) : 'your week'}"`;


  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: *** ${key}`, 'Content-Type': 'application/json' },
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

export async function notifyOwner(record) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'resend_not_configured' };
  const lines = [
    `New assessment ${record.paid ? 'PAID UNLOCK' : 'completion'} — score ${record.score}/18 (${TIER_LABEL[record.tier]})`,
    '',
    `Email: ${record.email}`,
    `Trade: ${record.trade || '(none)'}`,
    `Team size: ${record.teamSize || '(none)'}`,
    `Answers: ${JSON.stringify(record.answers)}`,
    `Task that eats their week: ${record.task}`,
    `UTM: ${JSON.stringify(record.utm || {})}`,
    `Completion ID: ${record.completion_id || '(none)'}`,
    `Stripe session: ${record.stripe_session_id || '(none)'}`,
    `Paid (verified): ${record.paid ? 'YES' : 'no'}`,
    record.needs_manual ? '*** NEEDS MANUAL FOLLOW-UP: paid Leak Finder breakdown generation failed, apology fallback sent — Daniel must email full breakdown within 24h ***' : '',
    `Submitted: ${record.ts}`,
  ].filter(Boolean);
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: *** ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Kynetica Assessments <daniel@mail.kynetica.one>',
      to: ['info@kynetica.one'],
      reply_to: [record.email],
      subject: `Assessment: ${record.score}/18 — ${record.trade || 'unknown trade'}${record.paid ? ' — PAID UNLOCK' : ''}`,
      text: lines.join('\n'),
    }),
  });
  if (!resp.ok) return { sent: false, reason: `resend_${resp.status}` };
  return { sent: true };
}

// ---- HMAC-signed completion payload (bound into Stripe metadata / email links) ----

function hmacKey() {
  const secret = process.env.STRIPE_SECRET_KEY || '';
  return crypto.createHash('sha256').update(secret).digest();
}

function canonicalize(fields) {
  return Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('&');
}

function signFields(fields) {
  return crypto.createHmac('sha256', hmacKey()).update(canonicalize(fields)).digest('hex');
}

// Builds the compact field set shared by Stripe metadata and the signed
// email-link token. Values are strings; caller re-parses answers/utm JSON.
export function buildPayloadFields(record) {
  return {
    completion_id: clean(record.completion_id, 40),
    score: String(record.score),
    tier: clean(record.tier, 40),
    trade: clean(record.trade, 20),
    teamSize: clean(record.teamSize, 10),
    email: clean(record.email, 254),
    task: clean(record.task, 400),
    answers: JSON.stringify(record.answers || []),
    utm: JSON.stringify(record.utm || {}).slice(0, 300),
  };
}

// Returns metadata object ready to hand to Stripe (all string values,
// <=500 chars each, well under the 50-key limit).
export function signedMetadata(record) {
  const fields = buildPayloadFields(record);
  const hmac = signFields(fields);
  return { ...fields, hmac };
}

export function verifyAndReconstruct(metadata) {
  if (!metadata || typeof metadata !== 'object') return { valid: false };
  const { hmac, ...fields } = metadata;
  if (!hmac) return { valid: false };
  const expected = signFields(fields);
  if (expected !== hmac) return { valid: false };
  let answers, utm;
  try { answers = JSON.parse(fields.answers || '[]'); } catch { answers = []; }
  try { utm = JSON.parse(fields.utm || '{}'); } catch { utm = {}; }
  return {
    valid: true,
    record: {
      completion_id: fields.completion_id,
      score: Number(fields.score),
      tier: fields.tier,
      trade: fields.trade,
      teamSize: fields.teamSize,
      email: fields.email,
      task: fields.task,
      answers,
      utm,
    },
  };
}

// Base64url token for the free-result email's $7 CTA: lets the recipient
// land on /assess?unlock_start=<token> and go straight to Stripe Checkout
// with no re-entry, without needing any server-side storage lookup.
export function encodeSignedLink(record) {
  const metadata = signedMetadata(record);
  const json = JSON.stringify(metadata);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeSignedLink(token) {
  try {
    const json = Buffer.from(String(token), 'base64url').toString('utf8');
    const metadata = JSON.parse(json);
    return verifyAndReconstruct(metadata);
  } catch (e) {
    return { valid: false };
  }
}

// ---- Stripe REST helpers (no SDK dependency, matches api/checkout.js) ----

export function toFormBody(params) {
  const pairs = [];
  function walk(prefix, value) {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    } else if (value && typeof value === 'object') {
      Object.entries(value).forEach(([k, v]) => walk(`${prefix}[${k}]`, v));
    } else if (value !== undefined && value !== null) {
      pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(value)}`);
    }
  }
  Object.entries(params).forEach(([k, v]) => walk(k, v));
  return pairs.join('&');
}

export function stripeAuthHeader() {
  const key = process.env.STRIPE_SECRET_KEY || '';
  return 'Basic ' + Buffer.from(`${key}:`).toString('base64');
}

export async function stripeGet(path) {
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: stripe...er() },
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

export async function stripePost(path, params) {
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: stripe...r(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: toFormBody(params),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}
