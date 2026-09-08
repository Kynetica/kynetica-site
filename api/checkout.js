// Creates a Stripe Checkout Session for the $249 automation audit.
// Called from the inline email-capture form on the landing page before
// redirecting the buyer to Stripe's hosted checkout. Uses the Stripe REST
// API directly via fetch (no SDK dependency).
//
// Env vars required:
//   STRIPE_SECRET_KEY - Stripe secret (live) key, set via `vc env add`.

const PRICE_ID = 'price_1UBlBlLJjM5m13mjiEvdFYKj';

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const e = email.trim();
  if (e.length < 5 || e.length > 254) return false;
  // Reasonably strict but not pedantic RFC-5322 check.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function toFormBody(params) {
  // Encodes a nested object into application/x-www-form-urlencoded using
  // Stripe's bracket notation, e.g. line_items[0][price]=xyz.
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      res.status(500).json({ error: 'Server not configured' });
      return;
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const email = (body.email || '').toString().trim();
    const website = (body.website || '').toString().trim().slice(0, 500);
    const bottleneck = (body.bottleneck || '').toString().trim().slice(0, 500);

    if (!isValidEmail(email)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }

    const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // now + 24h

    const params = {
      mode: 'payment',
      line_items: [
        { price: PRICE_ID, quantity: 1 },
      ],
      customer_email: email,
      success_url: 'https://kynetica.one/thanks?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://kynetica.one/?abandoned=1',
      after_expiration: { recovery: { enabled: true } },
      expires_at: expiresAt,
      metadata: {
        website: website || '',
        bottleneck: bottleneck || '',
        source: 'site-capture',
      },
      custom_fields: [
        {
          key: 'website',
          label: { type: 'custom', custom: 'Your website' },
          type: 'text',
          optional: true,
        },
        {
          key: 'bottleneck',
          label: { type: 'custom', custom: 'Biggest bottleneck' },
          type: 'text',
          optional: true,
        },
      ],
    };

    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: toFormBody(params),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('Stripe error:', data);
      res.status(502).json({ error: 'Could not start checkout. Please try again.' });
      return;
    }

    res.status(200).json({ url: data.url });
  } catch (e) {
    console.error('checkout handler error:', e);
    res.status(500).json({ error: 'Unexpected error. Please try again.' });
  }
}
