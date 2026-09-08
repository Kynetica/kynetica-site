// Resend webhook receiver: verifies Svix signature, then durably stores the
// event as one JSON line appended to a GitHub-hosted log file via the
// Contents API — same pattern as api/hit.js (this function's filesystem is
// ephemeral/read-only, so GitHub is the durable store).
//
// Env vars required (same GitHub repo as the hit counter, different path):
//   HIT_GH_TOKEN            - GitHub token with repo contents:write (reused)
//   HIT_GH_REPO             - "Kynetica/kynetica-hits" (reused)
//   RESEND_EVENTS_GH_PATH   - "resend-events.jsonl" (defaults to that)
//   RESEND_WEBHOOK_SECRET   - Svix signing secret from Resend dashboard
//                             (whsec_... format). If unset, events are still
//                             stored but flagged verified:false.
//
// Must disable Vercel's automatic body parsing so we can verify the Svix
// signature against the exact raw request bytes.
export const config = {
  api: {
    bodyParser: false,
  },
};

import crypto from 'crypto';

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Verifies a Svix-style webhook signature.
// signed_content = `${svixId}.${svixTimestamp}.${rawBody}`
// expected = base64(HMAC-SHA256(base64decode(secret_after_whsec_), signed_content))
// svix-signature header may contain multiple space-delimited "v1,<sig>" pairs.
function verifySvixSignature({ secret, svixId, svixTimestamp, rawBody, svixSignatureHeader }) {
  if (!secret || !svixId || !svixTimestamp || !svixSignatureHeader) return false;
  const secretKey = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  let secretBytes;
  try {
    secretBytes = Buffer.from(secretKey, 'base64');
  } catch {
    return false;
  }
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  const candidates = svixSignatureHeader
    .split(' ')
    .map((part) => part.includes(',') ? part.split(',')[1] : part)
    .filter(Boolean);
  for (const candidate of candidates) {
    try {
      const a = Buffer.from(candidate);
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch {
      // ignore malformed candidate, try next
    }
  }
  return false;
}

async function appendEventLine(line) {
  const token = process.env.HIT_GH_TOKEN;
  const repo = process.env.HIT_GH_REPO;
  const filePath = process.env.RESEND_EVENTS_GH_PATH || 'resend-events.jsonl';
  if (!token || !repo) {
    // Storage not configured — caller decides how to respond.
    return { stored: false, reason: 'gh_not_configured' };
  }
  const apiBase = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'kynetica-resend-webhook',
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
    message: `resend event ${new Date().toISOString()}`,
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    res.status(400).json({ error: 'body_read_failed' });
    return;
  }

  const svixId = req.headers['svix-id'];
  const svixTimestamp = req.headers['svix-timestamp'];
  const svixSignature = req.headers['svix-signature'];
  const secret = process.env.RESEND_WEBHOOK_SECRET;

  let verified = false;
  if (secret) {
    verified = verifySvixSignature({
      secret,
      svixId,
      svixTimestamp,
      rawBody,
      svixSignatureHeader: svixSignature,
    });
    if (!verified) {
      // Secret is configured and signature check failed -> reject.
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }
  }
  // No secret configured: accept but mark unverified (per spec — operator
  // has not yet mounted RESEND_WEBHOOK_SECRET).

  let payload;
  try {
    payload = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
  } catch (e) {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    verified,
    svix_id: svixId || null,
    type: payload.type || null,
    data: payload.data || null,
  }) + '\n';

  let storeResult;
  try {
    storeResult = await appendEventLine(line);
  } catch (e) {
    storeResult = { stored: false, reason: 'exception' };
  }

  if (!storeResult.stored) {
    // Storage failed or not configured — tell Resend so it retries, but
    // don't leak internal detail.
    res.status(202).json({ received: true, stored: false, reason: storeResult.reason });
    return;
  }

  res.status(200).json({ received: true, stored: true, verified });
}
