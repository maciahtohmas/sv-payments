// api/create-checkout.js
// Handles Premium ($2.99), Season Pass ($1.99/mo), Starter Bundle ($0.99)

const Stripe = require('stripe');

const PRODUCTS = {
  premium: {
    name: 'Samurai Vengeance Premium',
    description: 'Remove all ads forever · Bonus coins · Cloud save',
    amount: 299, mode: 'payment',
  },
  season: {
    name: 'Samurai Vengeance Season Pass',
    description: 'Double coins · Exclusive skin · Gold leaderboard name · All chapters',
    amount: 199, mode: 'subscription',
  },
  starter: {
    name: 'Samurai Vengeance Starter Bundle',
    description: 'Premium + 500 Coins + Bronze skin — one-time offer',
    amount: 99, mode: 'payment',
  },
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { userId, email, product = 'premium' } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const prod = PRODUCTS[product];
    if (!prod) return res.status(400).json({ error: 'Unknown product: ' + product });

    const BASE = 'https://samuraivengeance.com';
    const common = {
      customer_email: email || undefined,
      metadata: { userId, product },
      success_url: BASE + '?payment_success=' + product + '&session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  BASE + '?payment_cancel=1',
    };

    let session;
    if (prod.mode === 'subscription') {
      session = await stripe.checkout.sessions.create({
        ...common, mode: 'subscription',
        line_items: [{ price_data: {
          currency: 'usd', recurring: { interval: 'month' },
          unit_amount: prod.amount,
          product_data: { name: prod.name, description: prod.description },
        }, quantity: 1 }],
      });
    } else {
      session = await stripe.checkout.sessions.create({
        ...common, mode: 'payment', payment_method_types: ['card'],
        line_items: [{ price_data: {
          currency: 'usd', unit_amount: prod.amount,
          product_data: { name: prod.name, description: prod.description },
        }, quantity: 1 }],
      });
    }
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
};
