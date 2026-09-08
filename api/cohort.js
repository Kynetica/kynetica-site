// Free-cohort application handler for /cohort.
// Validates the submission, stores it durably as one JSON line appended to
// a GitHub-hosted log file (same pattern as api/hit.js — this function's
// filesystem is ephemeral/read-only, so GitHub is the durable store), then
// sends ONE notification email to info@kynetica.one via Resend. Never
// emails the applicant from this function.
//
// Env vars required:
//   HIT_GH_TOKEN     - GitHub token with repo contents:write (reused from hit.js)
//   HIT_GH_REPO      - "Kynetica/kynetica-hits" (reused)
//   COHORT_GH_PATH   - "cohort-applications.jsonl" (defaults to that)
//   RESEND_API_KEY   - Resend API key, used to send the info@ notification.

const TRADES = new Set(['HVAC', 'plumbing', 'electrical', 'roofing', 'other']);
const ROLES = new Set(['owner', 'office manager', 'other']);

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const e = email.trim();
  if (e.length < 5 || e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function clean(v, max) {
  return (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
}

async function appendLine(line) {
  const token = process.env.HIT_GH_TOKEN;
  const repo = process.env.HIT_GH_REPO;
  const filePath = process.env.COHORT_GH_PATH || 'cohort-applications.jsonl';
  if (!token || !repo) {
    return { stored: false, reason: 'gh_not_configured' };
  }
  const apiBase = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'kynetica-cohort',
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
    message: `cohort application ${new Date().toISOString()}`,
    content: Buffer.from(updated).toString('base64'),
    ...(sha ? { sha } : {}),
  };
  const putResp = await fetch(apiBase, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!putResp.ok) {
    return { stored: false, reason: `gh_put_${putResp.status}` };
  }
  return { stored: true };
}

async function notifyInfo(record) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: 'resend_not_configured' };
  const lines = [
    `Business: ${record.business}`,
    `Trade: ${record.trade}`,
    `Website: ${record.website || '(none)'}`,
    `Role: ${record.role}`,
    `Email: ${record.email}`,
    `Phone: ${record.phone || '(none)'}`,
    `UTM source: ${record.utm_source || '(none)'}`,
    `UTM campaign: ${record.utm_campaign || '(none)'}`,
    '',
    'Task eating their week:',
    record.task,
  ].join('\n');

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Kynetica Cohort <cohort@kynetica.one>',
      to: ['info@kynetica.one'],
      subject: `New free-cohort application: ${record.business}`,
      text: lines,
    }),
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = await resp.text(); } catch {}
    console.error('resend send failed:', resp.status, detail);
    return { sent: false, reason: `resend_${resp.status}` };
  }
  return { sent: true };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const business = clean(body.business, 200);
    const trade = clean(body.trade, 40);
    const website = clean(body.website, 300);
    const role = clean(body.role, 40);
    const task = clean(body.task, 2000);
    const email = clean(body.email, 254);
    const phone = clean(body.phone, 40);
    const utm_source = clean(body.utm_source, 200);
    const utm_campaign = clean(body.utm_campaign, 200);

    if (!business) {
      res.status(400).json({ ok: false, error: 'Business name is required.' });
      return;
    }
    if (!TRADES.has(trade)) {
      res.status(400).json({ ok: false, error: 'Please select a valid trade.' });
      return;
    }
    if (!ROLES.has(role)) {
      res.status(400).json({ ok: false, error: 'Please select your role.' });
      return;
    }
    if (!task) {
      res.status(400).json({ ok: false, error: 'Please tell us the one task eating your week.' });
      return;
    }
    if (!isValidEmail(email)) {
      res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
      return;
    }

    const record = {
      ts: new Date().toISOString(),
      business,
      trade,
      website,
      role,
      task,
      email,
      phone,
      utm_source,
      utm_campaign,
      ip: (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim().slice(0, 60),
    };

    const line = JSON.stringify(record) + '\n';

    let storeResult;
    try {
      storeResult = await appendLine(line);
    } catch (e) {
      console.error('cohort store error:', e);
      storeResult = { stored: false, reason: 'exception' };
    }

    if (!storeResult.stored) {
      console.error('cohort application not stored:', storeResult.reason, JSON.stringify(record));
      res.status(502).json({ ok: false, error: 'Could not save your application. Please try again or email info@kynetica.one.' });
      return;
    }

    try {
      await notifyInfo(record);
    } catch (e) {
      console.error('cohort notify error:', e);
      // Storage succeeded; don't fail the request over a notification hiccup.
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('cohort handler error:', e);
    res.status(500).json({ ok: false, error: 'Unexpected error. Please try again.' });
  }
}
