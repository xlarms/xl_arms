// points-lib.js — XL Arms points/rewards program (v1, 2026-11-21).
//
// Earn: 1 point per $1 of ITEMS (merchandise) total, whole dollars only
// (floor). Redeem: 100 points = $5 off, in 100-point blocks, ship-to-FFL
// orders only. Account holders only (verified Netlify Identity user).
// Guests earn nothing and cannot redeem. Points never expire (v1).
//
// Storage: Netlify Blobs store 'xl-arms-points', key = the Identity user
// ID (sub, a UUID). Value JSON:
//   { userId, email, balance, ledger: [{type:'earn'|'redeem', points,
//     orderId, at, note}], updatedAt }
// Ledger `points` is the SIGNED change (+N for earn, -N for redeem), so
// the ledger sums to the balance.
//
// SECURITY: the user ID passed in here must come from
// `context.clientContext.user` (Netlify populates it from a valid Identity
// JWT) — never from a request body. Callers are responsible for that;
// this module only stores what it is given.
//
// All functions catch Blobs failures and return a result object — they
// NEVER throw into the checkout flow. A store failure is reported via
// `ok: false` / a `reason` string, never an exception.

const POINTS_STORE = 'xl-arms-points';
const EARN_POINTS_PER_DOLLAR = 1;   // 1 point per $1 of items total
const REDEEM_BLOCK_POINTS = 100;    // redeem in 100-point blocks
const REDEEM_BLOCK_VALUE_CENTS = 500; // $5 off per 100 points

// Acquire the Blobs store — same pattern as get-products.js.
function pointsStore(event) {
  const { getStore, connectLambda } = require('@netlify/blobs');
  try { connectLambda(event); } catch (e) { /* non-Lambda context */ }
  return getStore(POINTS_STORE);
}

function blankRecord(userId, email) {
  return {
    userId: String(userId),
    email: email || '',
    balance: 0,
    ledger: [],
    updatedAt: new Date().toISOString(),
  };
}

// Read the full record. Returns null when there is no record OR when the
// store read fails (the failure is logged; callers treat null as "no
// record" for reads, and award/redeem re-check before writing).
async function readRecord(store, userId) {
  try {
    const rec = await store.get(String(userId), { type: 'json' });
    if (rec && typeof rec === 'object' && Array.isArray(rec.ledger) && typeof rec.balance === 'number') {
      return rec;
    }
    return null;
  } catch (e) {
    console.error('points-lib: read failed for user ' + userId + ':', e && e.message);
    return null;
  }
}

async function writeRecord(store, rec) {
  rec.updatedAt = new Date().toISOString();
  try {
    await store.setJSON(String(rec.userId), rec);
    return true;
  } catch (e) {
    console.error('points-lib: write failed for user ' + rec.userId + ':', e && e.message);
    return false;
  }
}

// Current balance for a user. Never throws; a store failure reads as
// balance 0 with ok:false so the caller can tell "unknown" from "zero".
async function getBalance(store, userId) {
  try {
    const rec = await store.get(String(userId), { type: 'json' });
    if (rec && typeof rec === 'object' && typeof rec.balance === 'number') {
      return { ok: true, balance: rec.balance, email: rec.email || '' };
    }
    return { ok: true, balance: 0, email: '' };
  } catch (e) {
    console.error('points-lib: balance read failed for user ' + userId + ':', e && e.message);
    return { ok: false, balance: 0, email: '' };
  }
}

// Award points for an order. Idempotent: an 'earn' ledger entry for the
// same orderId is never awarded twice. Returns
// { awarded, reason, balance } — balance is the on-disk balance after
// the call (unchanged when nothing was awarded).
async function awardPoints(store, userId, email, points, orderId, note) {
  const pts = Math.floor(Number(points) || 0);
  if (pts <= 0) {
    const cur = await getBalance(store, userId);
    return { awarded: false, reason: 'no-points', balance: cur.balance };
  }
  let rec = await readRecord(store, userId);
  if (!rec) rec = blankRecord(userId, email);
  if (rec.ledger.some((e) => e.type === 'earn' && e.orderId === orderId)) {
    return { awarded: false, reason: 'already-awarded', balance: rec.balance };
  }
  const oldBalance = rec.balance;
  rec.balance += pts;
  if (email && !rec.email) rec.email = email;
  rec.ledger.push({
    type: 'earn',
    points: pts,
    orderId: String(orderId),
    at: new Date().toISOString(),
    note: note || '',
  });
  const ok = await writeRecord(store, rec);
  if (!ok) return { awarded: false, reason: 'store-error', balance: oldBalance };
  return { awarded: true, reason: '', balance: rec.balance };
}

// Redeem points for an order. Validates the amount (multiple of 100) and
// the balance, and is idempotent: a 'redeem' ledger entry for the same
// orderId is never deducted twice. Returns
// { redeemed, reason, balance } — balance is the on-disk balance after
// the call (unchanged when nothing was redeemed).
async function redeemPoints(store, userId, points, orderId) {
  const pts = Math.floor(Number(points) || 0);
  if (pts <= 0 || pts % REDEEM_BLOCK_POINTS !== 0) {
    const cur = await getBalance(store, userId);
    return { redeemed: false, reason: 'invalid-amount', balance: cur.balance };
  }
  let rec = await readRecord(store, userId);
  if (!rec) return { redeemed: false, reason: 'no-balance', balance: 0 };
  if (rec.ledger.some((e) => e.type === 'redeem' && e.orderId === orderId)) {
    return { redeemed: false, reason: 'already-redeemed', balance: rec.balance };
  }
  if (rec.balance < pts) {
    return { redeemed: false, reason: 'insufficient-balance', balance: rec.balance };
  }
  const oldBalance = rec.balance;
  rec.balance -= pts;
  rec.ledger.push({
    type: 'redeem',
    points: -pts,
    orderId: String(orderId),
    at: new Date().toISOString(),
    note: 'Redeemed at checkout',
  });
  const ok = await writeRecord(store, rec);
  if (!ok) return { redeemed: false, reason: 'store-error', balance: oldBalance };
  return { redeemed: true, reason: '', balance: rec.balance };
}

module.exports = {
  POINTS_STORE,
  EARN_POINTS_PER_DOLLAR,
  REDEEM_BLOCK_POINTS,
  REDEEM_BLOCK_VALUE_CENTS,
  pointsStore,
  getBalance,
  awardPoints,
  redeemPoints,
};
