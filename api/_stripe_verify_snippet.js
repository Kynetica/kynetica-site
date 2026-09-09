/**
 * Equivalent Node.js snippet for verifying a Stripe Checkout Session is paid.
 * NOT WIRED IN — reference only for the /assess API route to adapt.
 *
 * Requires STRIPE_SECRET_KEY in the environment (never hardcode).
 *
 * Usage (example inside a serverless function):
 *   const result = await verifyStripeSession(req.query.session_id);
 *   if (!result.paid) return res.status(402).json({ error: "not paid" });
 *   // unlock paid result using result.email / result.amount
 */

async function verifyStripeSession(sessionId) {
  if (!sessionId) {
    throw new Error("missing session_id");
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY not set");
  }

  const resp = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    {
      headers: {
        Authorization: "Basic " + Buffer.from(`${key}:`).toString("base64"),
      },
    }
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`stripe error ${resp.status}: ${body.slice(0, 300)}`);
  }

  const session = await resp.json();

  if (session.payment_status !== "paid") {
    return { paid: false };
  }

  return {
    paid: true,
    email: session.customer_details?.email ?? null,
    amount: session.amount_total ?? null,
  };
}

module.exports = { verifyStripeSession };
