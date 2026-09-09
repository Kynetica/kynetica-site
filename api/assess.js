// Automation Readiness Assessment handler: validates the 9-question +
// free-text submission, scores it (0-18), calls Grok (xAI) for a
// personalised FREE result, emails that result to the prospect via Resend
// (CTA = $7 unlock, signed link, no $249 audit here), logs the full
// completion durably to GitHub, and returns { completion_id, score, tier,
// html } to the client. The completion_id plus signed metadata is what
// api/unlock.js uses later to bind a Stripe Checkout Session to this
// completion with NO re-entry and NO database.
//
// POST body: {
//   answers: number[9] (each 0/1/2),
//   task: string (1-500 chars, required),
//   trade: string, email: string, teamSize: string,
//   utm: { source, medium, campaign, ... } (optional passthrough, strings only)
// }
//
// Env vars required:
//   XAI_API_KEY      - xAI (Grok) API key
//   RESEND_API_KEY    - Resend API key
//   HIT_GH_TOKEN      - GitHub token with repo contents:write (reused from hit.js)
//   HIT_GH_REPO       - "Kynetica/kynetica-hits" (reused)
//   STRIPE_SECRET_KEY - used only to derive the HMAC key for signed links

import {
  TRADES, TEAM_SIZES,
  isValidEmail, clean, scoreAnswers, tierFor, genCompletionId,
  callGrok, fallbackResult, appendCompletionLine, emailResult, notifyOwner,
  encodeSignedLink,
} from './_completion.js';

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
  const completion_id = genCompletionId();

  const record = {
    ts: new Date().toISOString(),
    completion_id,
    score, tier, task, trade, teamSize, email,
    answers: body.answers,
    utm,
    paid: false,
  };

  let resultHtml;
  try {
    resultHtml = await callGrok(score, tier, task, trade, teamSize, false);
  } catch (e) {
    resultHtml = fallbackResult(score, tier, task, trade);
  }

  let storeResult, emailR, notifyR;
  try { storeResult = await appendCompletionLine(JSON.stringify(record) + '\n'); }
  catch (e) { storeResult = { stored: false, reason: 'exception' }; }

  // Signed link for the free-result email's $7 CTA: encodes the whole
  // completion (HMAC-signed) so the recipient can go straight to Stripe
  // Checkout later with zero re-entry, with no server-side lookup needed.
  let ctaUrl = 'https://kynetica.one/assess';
  try {
    const token = encodeSignedLink(record);
    ctaUrl = `https://kynetica.one/assess?unlock_start=${token}`;
  } catch (e) { /* fall back to bare /assess link */ }

  try { emailR = await emailResult(record, resultHtml, ctaUrl); }
  catch (e) { emailR = { sent: false, reason: 'exception' }; }

  try { notifyR = await notifyOwner(record); }
  catch (e) { notifyR = { sent: false, reason: 'exception' }; }

  res.status(200).json({
    completion_id, score, tier, html: resultHtml,
    stored: storeResult.stored, emailed: emailR.sent, notified: notifyR.sent,
  });
}
