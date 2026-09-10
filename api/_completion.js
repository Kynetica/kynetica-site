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
    `<p>That written read didn't finish just now. I'm not handing you a generic page instead. I'll write it and send it to the email you gave. Nothing is owed for it. If it hasn't turned up and you want to nudge me, reply to that email.</p>`,
    `<p>Daniel Kane, Kynetica (AI)</p>`,
  ].join('\n');
  return html;
}

export function paidFallbackResult(score, tier, task, trade) {
  const html = [
    `<p>You told us the task eating your week is: ${escapeHtml(task)}.</p>`,
    `<p>Your payment went through, and the detailed read of that task did not complete just now. You're not getting a generic page in its place. I'll write the full breakdown by hand and email it to you. It will come from this same address. If you want to check on it, reply to your result email.</p>`,
    `<p>Daniel Kane, Kynetica (AI)</p>`,
  ].join('\n');
  return html;
}

export async function callGrok(score, tier, task, trade, teamSize, paid) {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error('no_key');

  const baseRules = `You are Daniel Kane, the AI that runs Kynetica. You are writing to a small service-business owner who just answered nine questions and described, in one sentence, the task that eats their week. Write to that one person, about that one task, in plain first person.

Rules that never bend:
- Open the entire output by restating their described task in their own words, in one sentence, before any analysis. Example shape: "You told us the task eating your week is ___."
- Use their nouns. If they wrote "paper tickets" and "QuickBooks", your fix names paper tickets and QuickBooks, not a generic substitute.
- No invented statistics. No customer counts, testimonials, or claims of past results anywhere.
- No promises of results. Any hours or dollars figure is a rough estimate and must be labelled as an estimate or a guess in the same sentence.
- Never name a specific software product, model, or vendor as the automation approach. Name the category of tool ("a shared spreadsheet on a phone", "a connector", "a form that texts the office").
- Never mention any AI model or provider name. Never mention any price, any paid product, any audit, or any guarantee. You deliver the result; you do not sell anything.
- Plain, direct language. Short sentences mixed with a few longer ones. No jargon, no buzzwords, no exclamation points, no emoji, no em dashes.
- No generic advice. "Write down your process" or "map your workflow" without their task's nouns is banned.
- Sign off exactly: Daniel Kane, Kynetica (AI)
- Output plain HTML using only <p> and <strong> tags. No markdown, no headings, no lists, no links, no scripts.`;

  const freeStructure = `Structure, exactly, 180 to 250 words:
1. One paragraph that opens on one concrete detail from their actual answers and describes how their week runs from it. Never open with a description of their score tier.
2. One paragraph beginning with the bold words "Your biggest leak". It addresses their free-text task specifically, names one concrete automation approach using tools a business like theirs plausibly already owns, and gives one rough hours-per-week figure clearly labelled as an estimate.
3. Exactly one next step, specific to their named task, doable this week, containing at least one noun from their task.
4. The sign-off.`;

  const paidStructure = `Write the free structure above, 180 to 250 words, then a second section of 380 to 500 words that begins with the bold words "Your full breakdown". In this order:
a. Take their named task apart into its concrete steps, using the task's own nouns, in the order the steps actually happen.
b. Say which of those steps can be automated and, for each, the category of tool they plausibly already own. Say plainly which steps should stay manual.
c. Give a rough setup-effort figure in hours, labelled as an estimate.
d. Give a rough weekly-hours-recovered range, labelled as an estimate, not a promise.
e. Name two more secondary leaks inferred from their nine answers, not the named task, one sentence each.
Keep the same plain first-person voice in this section as in the opening. No report register, no headings inside paragraphs, no numbered lists. It should read like the same person kept talking, not like a template got filled in.
Sign off once, at the very end.`;

  const systemPrompt = paid
    ? `${baseRules}\n\n${freeStructure}\n\n${paidStructure}`
    : `${baseRules}\n\n${freeStructure}`;

  const answersNote = paid ? ' They have paid for the full breakdown; use all nine answer values plus their team size and trade to infer two secondary leaks beyond the named task.' : '';
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

// record.paid=false -> ctaUrl should be the $7 unlock link (signed link or
// plain /assess link). record.paid=true -> shows the $249 audit block.
export async function emailResult(record, resultHtml, ctaUrl) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'resend_not_configured' };

  let ctaBlock;
  if (record.paid) {
    ctaBlock = `
    <div style="margin:28px 0;padding:20px;background:#f5f7fa;border-radius:10px">
      <p style="margin:0 0 4px;font-weight:700">&ldquo;We'll find at least $1,000 a year in recoverable time and cost in your business, or the audit is free.&rdquo;</p>
      <p style="margin:0 0 12px;color:#333">One term, no fine print. You tell us; we refund.</p>
      <p style="margin:0 0 12px;color:#333">The breakdown above worked one task, the one you named. The Automation Audit reads your actual website, booking flow and back office, and prices out every leak it finds there.</p>
      <p style="margin:0 0 16px;color:#333">Written report, 6 to 10 pages: your top 5 automation opportunities, ranked by estimated hours saved and cost to implement, with an ROI estimate for each. A step-by-step plan naming the tools, delivered by email within 48 hours of checkout.</p>
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
    </div>`;
  } else {
    ctaBlock = `
    <div style="margin:28px 0;padding:20px;background:#f5f7fa;border-radius:10px">
      <p style="margin:0 0 12px;color:#333">This copy lives in your inbox, so star it or pin it. It's yours to keep.</p>
      <p style="margin:0 0 12px;color:#555">It named where the hours go in the task you described, and one step for this week. The full breakdown takes that same task and works every step: which ones you can automate with what you likely already own, a labelled setup estimate, a labelled hours-a-week estimate, and two more things it saw in your other answers.</p>
      <p style="margin:0 0 16px;color:#555">Your answers travel with the button below. Nothing to retype.</p>
      <a href="${ctaUrl}" style="display:inline-block;background:#111;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:700">Unlock the full breakdown: $7</a>
    </div>`;
  }

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;color:#1a1d24;line-height:1.6">
    <h2 style="margin:0 0 20px">${record.paid ? 'Your full breakdown, written from your nine answers and the task you named.' : 'Your result, written from your nine answers.'}</h2>
    <div>${resultHtml}</div>
    ${ctaBlock}
    <p style="color:#999;font-size:12px;margin-top:32px">
      This result was written by an AI (Daniel Kane, Kynetica) from the answers you gave and nothing else. Estimates are estimates. No claims of past results or guaranteed savings are made here. Matt Gibbs owns Kynetica and answers for it.<br>
      Kynetica LLC. 1110 Brickell Avenue, Suite 400 #K381, Miami, FL 33131<br>
      <a href="mailto:info@kynetica.one?subject=unsubscribe">Unsubscribe</a>
    </p>
  </div>`;

  const subject = record.paid
    ? `your full breakdown is ready.`
    : `your result: the leak in "${record.task ? record.task.slice(0, 40) : 'your week'}".`;


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
    record.needs_manual ? '*** NEEDS MANUAL FOLLOW-UP: paid breakdown generation failed, fallback sent. Daniel must email the full breakdown by hand (no window promised to the customer) ***' : '',
    `Submitted: ${record.ts}`,
  ].filter(Boolean);
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
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
    headers: { Authorization: stripeAuthHeader() },
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

export async function stripePost(path, params) {
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: stripeAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: toFormBody(params),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}
