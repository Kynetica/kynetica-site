// /api/unsubscribe: one-click unsubscribe (RFC 8058) for every Kynetica outreach and sequence email.
// GET  ?t=<token>  -> records the suppression, shows a one-line confirmation (no form, no reasons, no re-subscribe pitch).
// POST ?t=<token>  with body "List-Unsubscribe=One-Click" (mail clients) -> records silently, 200.
// Token = base64url(email) + "." + HMAC-SHA256(email, UNSUB_SECRET) first 32 hex, minted by tools/resend_send.py.
// Record: appended to Kynetica/kynetica-hits unsubscribes.jsonl (same store as hits/completions). tools/resend_send.py syncs it
// into ~/life/orders/suppression.csv before every send, so a suppression is enforced within one send cycle.
import crypto from 'crypto';

function verify(t, secret) {
  const [b, sig] = String(t || '').split('.');
  if (!b || !sig) return null;
  let email; try { email = Buffer.from(b.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return null; }
  const want = crypto.createHmac('sha256', secret).update(email.toLowerCase()).digest('hex').slice(0, 32);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  return email.toLowerCase();
}

async function record(line) {
  const token = process.env.HIT_GH_TOKEN, repo = process.env.HIT_GH_REPO;
  if (!token || !repo) return { stored: false, reason: 'gh_not_configured' };
  const api = `https://api.github.com/repos/${repo}/contents/unsubscribes.jsonl`;
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'kynetica-unsubscribe', Accept: 'application/vnd.github+json' };
  for (let i = 0; i < 3; i++) {
    const g = await fetch(api, { headers }); let sha, existing = '';
    if (g.ok) { const d = await g.json(); sha = d.sha; existing = Buffer.from(d.content, 'base64').toString('utf8'); }
    const body = { message: 'unsubscribe', content: Buffer.from(existing + line).toString('base64') }; if (sha) body.sha = sha;
    const p = await fetch(api, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (p.ok) return { stored: true };
    if (p.status !== 409) return { stored: false, status: p.status };
  }
  return { stored: false, reason: 'conflict' };
}

const PAGE = (email) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Unsubscribed. Kynetica</title><link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;700;800&display=swap" rel="stylesheet"><link rel="stylesheet" href="/control.css"></head><body><div class="wrap"><header class="site"><div class="brand"><a href="/">Kynetica</a></div></header><section class="first"><h1>Unsubscribed.</h1><p>${email} will not get another email from Kynetica. Done; nothing else to click.</p><p class="cap">If this was a mistake, write to <a href="mailto:info@kynetica.one">info@kynetica.one</a>.</p></section></div></body></html>`;

export default async function handler(req, res) {
  const secret = process.env.UNSUB_SECRET;
  if (!secret) { res.status(500).send('unsubscribe not configured'); return; }
  const email = verify((req.query || {}).t, secret);
  if (!email) { res.status(400).send('That unsubscribe link is not valid. Write to info@kynetica.one and I remove you myself.'); return; }
  const line = JSON.stringify({ ts: new Date().toISOString(), email, method: req.method, ua: String(req.headers['user-agent'] || '').slice(0, 120), one_click: /One-Click/i.test(String(req.body || '')) || String(req.headers['content-type'] || '').includes('form') }) + '\n';
  const r = await record(line);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'POST') { res.status(r.stored ? 200 : 202).end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.status(200).send(PAGE(email));
}
