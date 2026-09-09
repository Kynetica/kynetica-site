// Checkout-session-creation endpoint for the $249 Automation Audit,
// reached from the PAID result's upsell (on-screen button and paid email
// CTA). Mirrors api/unlock.js's "Checkout Session as the record" pattern:
//
//   POST /api/audit  { completion_id, score, tier, task, trade, teamSize,
//                       email, answers, utm, paid_session }
//   -> paid_session must be the Stripe Checkout Session id of the ALREADY
//      PAID $7 unlock (verified against Stripe exactly like unlock.js's
//      retrieveAndDeliver: payment_status==='paid', amount_total>=700, and
//      a valid HMAC-signed metadata payload). This proves the visitor
//      actually paid for and holds a valid Leak Finder unlock before they
//      can start the $249 audit checkout.
//   -> on success, creates a new Stripe Checkout Session (mode=payment,
//      $249 audit price) with the full signed completion embedded in
//      metadata (same signing helpers as unlock.js), one optional custom
//      field ("website"), and returns { url } to redirect to Stripe.
//
// NOTHING is stored server-side: the new Checkout Session IS the record,
// same as the $7 unlock. tools/audit_deliver.py reads task/trade/teamSize/
// answers back out of this session's metadata at ingest time.
//
// Supports both JS fetch() callers (JSON body, JSON response) and plain
// HTML <form method="POST"> callers (e.g. the paid result email, which
// cannot run JS) — form-encoded submissions get a 303 redirect straight
// to the Stripe url instead of a JSON body, since a plain form can't read
// a JSON response.
//
// Env vars required: STRIPE_SECRET_KEY (read the same way unlock.js reads it).

import {
  clean, isValidEmail, scoreAnswers, tierFor, TRADES, TEAM_SIZES,
  signedMetadata, verifyAndReconstruct, stripeGet, stripePost,
} from './_completion.js';

const AUDIT_PRICE_ID = 'price_1UBlBlLJjM5m13mjiEvdFYKj';

async function verifyPaidSession(sessionId) {
  if (!sessionId) return false;
  const sessionResp = await stripeGet(`checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (!sessionResp.ok) return false;
  const session = sessionResp.data;
  const paid = session.payment_status === 'paid' && (session.amount_total || 0) >= 700;
  if (!paid) return false;
  const verify = verifyAndReconstruct(session.metadata);
  return verify.valid;
}

async function createAuditCheckoutSession(record, paidSessionId) {
  const metadata = signedMetadata(record);
  const params = {
    mode: 'payment',
    line_items: [{ price: AUDIT_PRICE_ID, quantity: 1 }],
    customer_email: record.email,
    success_url: 'https://kynetica.one/thanks?audit={CHECKOUT_SESSION_ID}',
    cancel_url: `https://kynetica.one/assess?unlock=${encodeURIComponent(paidSessionId)}`,
    client_reference_id: record.completion_id,
    metadata,
    custom_fields: [
      {
        key: 'website',
        label: { type: 'custom', custom: 'Your website' },
        type: 'text',
        optional: true,
      },
    ],
  };
  return stripePost('checkout/sessions', params);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const contentType = String(req.headers['content-type'] || '');
  const isFormPost = contentType.includes('application/x-www-form-urlencoded')
    || contentType.includes('multipart/form-data');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const paidSession = clean(body.paid_session, 200);
  if (!paidSession) { res.status(400).json({ error: 'missing_paid_session' }); return; }

  let paidVerified = false;
  try {
    paidVerified = await verifyPaidSession(paidSession);
  } catch (e) {
    res.status(500).json({ error: 'unexpected_error' });
    return;
  }
  if (!paidVerified) { res.status(402).json({ error: 'payment_not_verified' }); return; }

  let answers = body.answers;
  if (typeof answers === 'string') {
    try { answers = JSON.parse(answers); } catch { answers = []; }
  }
  let utmRaw = body.utm;
  if (typeof utmRaw === 'string') {
    try { utmRaw = JSON.parse(utmRaw); } catch { utmRaw = {}; }
  }
  utmRaw = utmRaw || {};

  const score = scoreAnswers(answers);
  const task = clean(body.task, 500);
  const email = clean(body.email, 254);
  let trade = clean(body.trade, 20);
  let teamSize = clean(body.teamSize, 10);
  const completion_id = clean(body.completion_id, 40);

  if (!TRADES.has(trade)) trade = 'Other';
  if (!TEAM_SIZES.has(teamSize)) teamSize = '';

  if (score === null || !task || !isValidEmail(email) || !completion_id) {
    res.status(400).json({ error: 'invalid_completion' });
    return;
  }

  const utm = {};
  for (const k of Object.keys(utmRaw)) {
    if (/^utm_/.test(k)) utm[k] = clean(utmRaw[k], 200);
  }

  const record = {
    completion_id, score, tier: body.tier || tierFor(score),
    task, trade, teamSize, email, answers, utm,
  };

  try {
    const result = await createAuditCheckoutSession(record, paidSession);
    if (!result.ok) {
      res.status(502).json({ error: 'stripe_error', detail: result.data?.error?.message || result.status });
      return;
    }
    if (isFormPost) {
      res.writeHead(303, { Location: result.data.url });
      res.end();
      return;
    }
    res.status(200).json({ url: result.data.url });
  } catch (e) {
    res.status(500).json({ error: 'unexpected_error' });
  }
}
