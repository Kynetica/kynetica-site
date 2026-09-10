// Unlock endpoint for the $7 "Automation Leak Finder" paid breakdown.
// Two actions on one route, chosen by presence of session_id:
//
// 1) POST /api/unlock  { completion_id, score, tier, task, trade,
//                        teamSize, email, answers, utm }
//    -> re-validates the completion payload the browser already holds in
//       memory (from the free /api/assess response), creates a Stripe
//       Checkout Session (mode=payment, $7 price) with the FULL signed
//       completion embedded in metadata, and returns { url } to redirect
//       the browser to Stripe. NOTHING is stored server-side: the
//       Checkout Session IS the record.
//
// 2) GET or POST /api/unlock?session_id=cs_...  (also accepts body.session_id)
//    -> retrieves the session from Stripe, verifies payment_status==='paid'
//       and amount_total>=700, verifies the metadata HMAC, reconstructs the
//       completion, calls callGrok(paid=true), returns
//       { paid: true, score, tier, html }, and (idempotently, keyed off the
//       PaymentIntent's own metadata.delivered flag — Checkout Session
//       metadata itself is immutable after creation) sends the paid result
//       email + owner notification exactly once.
//
// Env vars required: STRIPE_SECRET_KEY, XAI_API_KEY, RESEND_API_KEY,
//   HIT_GH_TOKEN, HIT_GH_REPO (for durable logging of the paid unlock).

import {
  clean, isValidEmail, scoreAnswers, tierFor, TRADES, TEAM_SIZES,
  callGrok, paidFallbackResult, emailResult, notifyOwner, appendCompletionLine,
  signedMetadata, verifyAndReconstruct, decodeSignedLink,
  UNLOCK_PRICE_ID, stripeGet, stripePost,
} from './_completion.js';

async function createCheckoutSession(record) {
  const metadata = signedMetadata(record);
  const params = {
    mode: 'payment',
    line_items: [{ price: UNLOCK_PRICE_ID, quantity: 1 }],
    customer_email: record.email,
    success_url: 'https://kynetica.one/assess?unlock={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://kynetica.one/assess?cancelled=1',
    client_reference_id: record.completion_id,
    metadata,
  };
  return stripePost('checkout/sessions', params);
}

async function retrieveAndDeliver(sessionId) {
  const sessionResp = await stripeGet(
    `checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent`
  );
  if (!sessionResp.ok) return { paid: false, reason: `stripe_${sessionResp.status}` };
  const session = sessionResp.data;

  const paid = session.payment_status === 'paid' && (session.amount_total || 0) >= 700;
  if (!paid) return { paid: false, reason: 'not_paid' };

  const verify = verifyAndReconstruct(session.metadata);
  if (!verify.valid) return { paid: false, reason: 'bad_signature' };

  const rec = verify.record;
  const score = scoreAnswers(rec.answers) ?? rec.score;
  const tier = rec.tier || tierFor(score);

  let resultHtml, needsManual = false;
  try {
    resultHtml = await callGrok(score, tier, rec.task, rec.trade, rec.teamSize, true);
  } catch (e) {
    resultHtml = paidFallbackResult(score, tier, rec.task, rec.trade);
    needsManual = true;
  }

  // Idempotency: Checkout Session metadata can't be updated after
  // creation, so we key delivery on the linked PaymentIntent's own
  // metadata instead.
  const paymentIntentId = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id;
  let alreadyDelivered = false;
  if (typeof session.payment_intent === 'object' && session.payment_intent) {
    alreadyDelivered = session.payment_intent.metadata?.delivered === '1';
  } else if (paymentIntentId) {
    const piResp = await stripeGet(`payment_intents/${encodeURIComponent(paymentIntentId)}`);
    if (piResp.ok) alreadyDelivered = piResp.data.metadata?.delivered === '1';
  }

  if (!alreadyDelivered) {
    const fullRecord = {
      ts: new Date().toISOString(),
      completion_id: rec.completion_id,
      score, tier, task: rec.task, trade: rec.trade, teamSize: rec.teamSize,
      email: session.customer_details?.email || rec.email,
      answers: rec.answers, utm: rec.utm,
      stripe_session_id: sessionId,
      paid: true,
      needs_manual: needsManual,
    };
    try { await appendCompletionLine(JSON.stringify(fullRecord) + '\n'); } catch (e) {}
    try { await emailResult(fullRecord, resultHtml); } catch (e) {}
    try { await notifyOwner(fullRecord); } catch (e) {}
    if (paymentIntentId) {
      try { await stripePost(`payment_intents/${encodeURIComponent(paymentIntentId)}`, { metadata: { delivered: '1' } }); } catch (e) {}
    }
  }

  return { paid: true, score, tier, html: resultHtml,
    record: { completion_id: rec.completion_id, score, tier, task: rec.task, trade: rec.trade, teamSize: rec.teamSize,
              email: session.customer_details?.email || rec.email, answers: rec.answers, utm: rec.utm } };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const sessionIdFromQuery = req.query && req.query.session_id;

  // --- Retrieval path: session_id present (GET or POST) ---
  if (sessionIdFromQuery || (req.method === 'POST' && req.body && (() => {
        let b = req.body;
        if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
        return !!(b && b.session_id);
      })())) {
    let sessionId = sessionIdFromQuery;
    if (!sessionId && req.method === 'POST') {
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
      sessionId = b && b.session_id;
    }
    try {
      const result = await retrieveAndDeliver(clean(sessionId, 200));
      res.status(200).json(result);
    } catch (e) {
      res.status(200).json({ paid: false, reason: 'exception' });
    }
    return;
  }

  // --- Checkout-session-creation path: POST with completion payload ---
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // Signed-link path: the free-result email's CTA carries a base64url
  // token (HMAC-signed completion) instead of raw fields the browser
  // "already holds in memory" — e.g. when the visitor returns days later
  // from their inbox with no in-page state at all.
  if (body.token) {
    const decoded = decodeSignedLink(body.token);
    if (!decoded.valid) { res.status(400).json({ error: 'invalid_token' }); return; }
    try {
      const result = await createCheckoutSession(decoded.record);
      if (!result.ok) {
        res.status(502).json({ error: 'stripe_error', detail: result.data?.error?.message || result.status });
        return;
      }
      res.status(200).json({ url: result.data.url });
    } catch (e) {
      res.status(500).json({ error: 'unexpected_error' });
    }
    return;
  }

  const score = scoreAnswers(body.answers);
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

  const utmRaw = body.utm || {};
  const utm = {};
  for (const k of Object.keys(utmRaw)) {
    if (/^utm_/.test(k)) utm[k] = clean(utmRaw[k], 200);
  }

  const record = {
    completion_id, score, tier: body.tier || tierFor(score),
    task, trade, teamSize, email, answers: body.answers, utm,
  };

  try {
    const result = await createCheckoutSession(record);
    if (!result.ok) {
      res.status(502).json({ error: 'stripe_error', detail: result.data?.error?.message || result.status });
      return;
    }
    res.status(200).json({ url: result.data.url });
  } catch (e) {
    res.status(500).json({ error: 'unexpected_error' });
  }
}
