// Agency inquiry form handler: validates the submission, stores it durably
// (same GitHub-append pattern as api/hit.js / api/resend-webhook.js — this
// function's filesystem is ephemeral, so GitHub is the durable store), and
// sends ONE notification email to info@kynetica.one via the Resend API.
// Never emails the prospect.
//
// POST body: { name, agency, email, website, offer('audits'|'qa'), sites, notes }
//
// Env vars required:
//   HIT_GH_TOKEN     - GitHub token with repo contents:write (reused from hit.js)
//   HIT_GH_REPO      - "Kynetica/kynetica-hits" (reused)
//   INQUIRY_GH_PATH  - "inquiries.jsonl" (defaults to that)
//   RESEND_API_KEY   - Resend API key, set via `vc env add` (set from
//                       /root/.config/resend/api_key by set_vercel_env.py)

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const e = email.trim();
  if (e.length < 5 || e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function clean(v, max) {
  return (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
}

async function appendInquiryLine(line) {
  const token = process.env.HIT_GH_TOKEN;
  const repo = process.env.HIT_GH_REPO;
  const filePath = process.env.INQUIRY_GH_PATH || 'inquiries.jsonl';
  if (!token || !repo) {
    return { stored: false, reason: 'gh_not_configured' };
  }
  const apiBase = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const headers = {
    Authorization: `token ${token}`,
    'User-Agent': 'kynetica-inquiry-form',
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
    message: `inquiry ${new Date().toISOString()}`,
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

async function notifyOwner(record) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'resend_not_configured' };

  const offerLabel = record.offer === 'qa' ? 'Weekly Lead-Path QA' : 'Agency Audit Pack';
  const lines = [
    `New agency inquiry — ${offerLabel}`,
    '',
    `Name: ${record.name}`,
    `Agency: ${record.agency}`,
    `Email: ${record.email}`,
    `Website: ${record.website || '(none given)'}`,
    `Offer: ${offerLabel}`,
    `Client sites: ${record.sites || '(none given)'}`,
    `Notes: ${record.notes || '(none)'}`,
    '',
    `Submitted: ${record.ts}`,
  ];

  const body = {
    from: 'Kynetica Inquiries <daniel@mail.kynetica.one>',
    to: ['info@kynetica.one'],
    reply_to: [record.email],
    subject: `Agency inquiry: ${record.agency} — ${offerLabel}`,
    text: lines.join('\n'),
  };

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    return { sent: false, reason: `resend_${resp.status}` };
  }
  return { sent: true };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const name = clean(body.name, 200);
  const agency = clean(body.agency, 200);
  const email = clean(body.email, 254);
  const website = clean(body.website, 300);
  const offer = clean(body.offer, 20);
  const sites = clean(body.sites, 500);
  const notes = clean(body.notes, 2000);

  if (!name || !agency || !isValidEmail(email) || (offer !== 'audits' && offer !== 'qa')) {
    res.status(400).json({ error: 'invalid_submission' });
    return;
  }

  const record = {
    ts: new Date().toISOString(),
    name,
    agency,
    email,
    website,
    offer,
    sites,
    notes,
  };

  const line = JSON.stringify(record) + '\n';

  let storeResult;
  try {
    storeResult = await appendInquiryLine(line);
  } catch (e) {
    storeResult = { stored: false, reason: 'exception' };
  }

  let notifyResult;
  try {
    notifyResult = await notifyOwner(record);
  } catch (e) {
    notifyResult = { sent: false, reason: 'exception' };
  }

  // The form succeeds for the caller as long as we validated the input;
  // storage/notify failures are logged in the response for debugging but
  // don't block the { ok: true } contract (never leave a real prospect
  // stuck on a form error because of a downstream integration hiccup).
  res.status(200).json({ ok: true, stored: storeResult.stored, notified: notifyResult.sent });
}
