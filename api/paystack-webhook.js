const nodemailer = require('nodemailer');

// EDIT PRICES HERE. These must match your Paystack pages exactly.
// Amounts are in the smallest unit: kobo for NGN, cents for USD.
const PRICES = [
  { plan: '2_weeks',  currency: 'NGN', amount: 4100 * 100 },
  { plan: '1_month',  currency: 'NGN', amount: 6800 * 100 },
  { plan: '3_months', currency: 'NGN', amount: 16400 * 100 },
  { plan: '1_year',   currency: 'NGN', amount: 47800 * 100 },
  { plan: '2_weeks',  currency: 'USD', amount: 300 },
  { plan: '1_month',  currency: 'USD', amount: 500 },
  { plan: '3_months', currency: 'USD', amount: 1200 },
  { plan: '1_year',   currency: 'USD', amount: 3500 },
];

const PLAN_LABEL = {
  '2_weeks': '2 weeks',
  '1_month': '1 month',
  '3_months': '3 months',
  '1_year': '1 year',
};

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sb(path, options = {}) {
  return fetch(SB_URL + '/rest/v1/' + path, {
    ...options,
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

async function sendKeyEmail(to, plan, key) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  const label = PLAN_LABEL[plan];
  const text =
    'Thank you for your purchase.\n\n' +
    'Your Channel Pilot license key (' + label + '):\n\n' + key + '\n\n' +
    'To activate it:\n' +
    '1. Open https://channelpilot.indevs.in/generator.html\n' +
    '2. Sign in with Google\n' +
    '3. Paste the key in the license box\n\n' +
    'Your ' + label + ' starts when you activate the key, not when you paid.\n' +
    'If you renew early, your remaining days carry over.\n\n' +
    'Questions? Reply to this email.';
  const html =
    '<div style="font-family:Arial,sans-serif;max-width:480px;line-height:1.6;color:#101a33">' +
    '<h2>Thank you for your purchase</h2>' +
    '<p>Your Channel Pilot license key (' + label + '):</p>' +
    '<p style="font-size:18px;font-weight:bold;letter-spacing:1px;background:#f5f8fe;padding:14px;border-radius:8px">' + key + '</p>' +
    '<ol><li>Open <a href="https://channelpilot.indevs.in/generator.html">the generator</a></li>' +
    '<li>Sign in with Google</li><li>Paste the key in the license box</li></ol>' +
    '<p>Your ' + label + ' starts when you activate the key, not when you paid. If you renew early, your remaining days carry over.</p>' +
    '<p>Questions? Reply to this email.</p></div>';
  await transporter.sendMail({
    from: '"Channel Pilot" <' + process.env.GMAIL_USER + '>',
    to,
    subject: 'Your Channel Pilot license key',
    text,
    html,
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (body.event !== 'charge.success') return res.status(200).json({ ignored: true });
    const reference = body.data && body.data.reference;
    if (!reference) return res.status(400).json({ error: 'no reference' });

    // Do not trust the webhook body. Ask Paystack directly whether this payment succeeded.
    const vr = await fetch(
      'https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference),
      { headers: { Authorization: 'Bearer ' + process.env.PAYSTACK_SECRET_KEY } }
    );
    const vj = await vr.json();
    if (!vr.ok || !vj.data || vj.data.status !== 'success') {
      return res.status(400).json({ error: 'payment not verified' });
    }
    const tx = vj.data;
    const email = ((tx.customer && tx.customer.email) || '').toLowerCase();
    const ref = encodeURIComponent(reference);

    // Already handled?
    let rows = await (await sb('payments?reference=eq.' + ref + '&select=*')).json();
    let row = rows[0];
    if (row && row.emailed_at) return res.status(200).json({ done: true });

    // First time: save the customer record
    if (!row) {
      const match = PRICES.find(p => p.currency === tx.currency && p.amount === tx.amount);
      const ins = await sb('payments', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          reference,
          email,
          amount: tx.amount,
          currency: tx.currency,
          plan: match ? match.plan : null,
          status: match ? 'received' : 'unmatched',
          paid_at: tx.paid_at,
          raw: tx,
        }),
      });
      if (!ins.ok) throw new Error('insert failed: ' + (await ins.text()));
      row = (await ins.json())[0];
    }

    // Amount did not match any plan: kept in the table for you to review
    if (!row.plan) return res.status(200).json({ unmatched: true });

    // Create the license
    if (!row.license_key) {
      const g = await sb('rpc/generate_license', {
        method: 'POST',
        body: JSON.stringify({ p_plan: row.plan, p_payment_reference: reference }),
      });
      if (!g.ok) throw new Error('generate_license failed: ' + (await g.text()));
      const key = await g.json();
      await sb('payments?reference=eq.' + ref, {
        method: 'PATCH',
        body: JSON.stringify({ license_key: key, status: 'paid' }),
      });
      row.license_key = key;
    }

    // Email it. If this fails we return 500 and Paystack retries.
    await sendKeyEmail(row.email || email, row.plan, row.license_key);

    // Delivered: remove the raw key from the table
    await sb('payments?reference=eq.' + ref, {
      method: 'PATCH',
      body: JSON.stringify({
        emailed_at: new Date().toISOString(),
        license_key: null,
        status: 'delivered',
      }),
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('paystack-webhook error:', err);
    return res.status(500).json({ error: 'server error' });
  }
};