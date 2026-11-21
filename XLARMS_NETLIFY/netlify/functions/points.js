// points.js — XL Arms points/rewards balance lookup.
//
// GET /.netlify/functions/points  (redirected as /api/points)
//   Returns the signed-in user's points balance. Account holders only:
//   the user comes from `context.clientContext.user`, which Netlify
//   populates when the browser sends a valid Identity JWT as
//   `Authorization: Bearer <token>`. Guests get 401 — the body's email is
//   never trusted for identity, and this endpoint never writes points.
//
// Response: { ok:true, balance, email, earnRate:1, redeemRate:100,
//             redeemValue:5 }
//   earnRate 1  = 1 point per $1 of items total.
//   redeemRate 100 / redeemValue 5 = 100 points = $5 off, in 100-point
//   blocks, ship-to-FFL orders only. Points never expire (v1).
// No other methods. A Blobs failure returns 503 (not a 0 balance) so the
// client can tell "unknown" from "zero".

const pointsLib = require('./points-lib');

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: 'Method not allowed.' });
  }
  const user = context && context.clientContext && context.clientContext.user;
  if (!user || !user.sub) {
    return json(401, { ok: false, error: 'Sign in to see your points.' });
  }
  try {
    const store = pointsLib.pointsStore(event);
    const bal = await pointsLib.getBalance(store, user.sub);
    if (!bal.ok) {
      return json(503, { ok: false, error: 'Could not load your points right now. Please try again.' });
    }
    return json(200, {
      ok: true,
      balance: bal.balance,
      email: user.email || bal.email || '',
      earnRate: pointsLib.EARN_POINTS_PER_DOLLAR,
      redeemRate: pointsLib.REDEEM_BLOCK_POINTS,
      redeemValue: pointsLib.REDEEM_BLOCK_VALUE_CENTS / 100,
    });
  } catch (e) {
    console.error('points: failed for user ' + user.sub + ':', e && e.message);
    return json(503, { ok: false, error: 'Could not load your points right now. Please try again.' });
  }
};
