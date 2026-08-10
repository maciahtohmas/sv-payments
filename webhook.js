// api/webhook.js
// Handles: premium, season pass, starter pack, subscription renewals/cancellations

const Stripe = require('stripe');
const admin  = require('firebase-admin');

// ── Firebase Admin init (singleton) ──────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Grant premium in Firestore ────────────────────────────────────
async function grantPremium(userId) {
  const batch = db.batch();
  batch.set(db.collection('players').doc(userId),
    { isPrem: true, premGrantedAt: new Date().toISOString() },
    { merge: true });
  batch.set(db.collection('leaderboard').doc(userId),
    { isPrem: true }, { merge: true });
  await batch.commit();
  console.log('✅ Premium granted:', userId);
}

// ── Grant season pass (30 days) ───────────────────────────────────
async function grantSeason(userId, subscriptionId) {
  const expiry = Date.now() + 31 * 24 * 60 * 60 * 1000; // 31 days
  const batch = db.batch();
  batch.set(db.collection('players').doc(userId), {
    hasSeason: true,
    seasonExpiry: new Date(expiry).toISOString(),
    seasonSubId: subscriptionId || '',
    seasonGrantedAt: new Date().toISOString(),
  }, { merge: true });
  batch.set(db.collection('leaderboard').doc(userId),
    { hasSeason: true }, { merge: true });
  await batch.commit();
  console.log('✅ Season pass granted:', userId, 'expires:', new Date(expiry).toISOString());
}

// ── Grant starter bundle ──────────────────────────────────────────
async function grantStarter(userId) {
  const batch = db.batch();
  // Starter = premium + 500 coins + bronze skin flag
  batch.set(db.collection('players').doc(userId), {
    isPrem: true,
    starterClaimed: true,
    starterCoins: admin.firestore.FieldValue.increment(500),
    starterSkin: 'bronze',
    premGrantedAt: new Date().toISOString(),
  }, { merge: true });
  batch.set(db.collection('leaderboard').doc(userId),
    { isPrem: true }, { merge: true });
  await batch.commit();
  console.log('✅ Starter bundle granted:', userId);
}

// ── Revoke season pass on cancellation ───────────────────────────
async function revokeSeason(userId) {
  await db.collection('players').doc(userId).set(
    { hasSeason: false, seasonExpiry: null },
    { merge: true }
  );
  console.log('⚠ Season pass revoked:', userId);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripe    = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig       = req.headers['stripe-signature'];
  const rawBody   = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: 'Webhook error: ' + err.message });
  }

  try {
    // ── Payment completed (premium / starter / season one-time) ──
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { userId, product } = session.metadata || {};
      if (!userId) { console.log('No userId in metadata'); return res.status(200).json({ received: true }); }

      if (product === 'premium')  await grantPremium(userId);
      if (product === 'starter')  await grantStarter(userId);
      if (product === 'season')   await grantSeason(userId, session.subscription);
    }

    // ── Subscription renewed (season pass monthly renewal) ────────
    if (event.type === 'invoice.paid') {
      const invoice = event.data.object;
      const sub = await stripe.subscriptions.retrieve(invoice.subscription);
      const userId = sub.metadata?.userId;
      if (userId) await grantSeason(userId, invoice.subscription);
    }

    // ── Subscription cancelled ────────────────────────────────────
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const userId = sub.metadata?.userId;
      if (userId) await revokeSeason(userId);
    }

  } catch (err) {
    console.error('Firestore update failed:', err.message);
    // Return 200 so Stripe doesn't retry — log for manual fix
  }

  res.status(200).json({ received: true });
};
