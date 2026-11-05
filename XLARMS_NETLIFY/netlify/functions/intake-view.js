// intake-view.js — XL Arms staff-only view of pre-pickup intakes.
//
// Staff only. Every action except a signed photo link requires the staff
// secret, read from env var INTAKE_STAFF_SECRET (Jonathan enters the value
// in Netlify himself; no value is ever in this file). If the secret is not
// set, every request is refused. No public listing, no public URL for a
// submission, and the ID photo is never in a list response.
//
// Actions (all under /.netlify/functions/intake-view):
//   GET  ?action=list
//        → [{ id, fullName, product, orderRef, pickupDay, submitted_at,
//             pickup_at, status }] — metadata only, no photo, no pre-signature.
//   GET  ?action=detail&id=<id>
//        → full record + short-lived signed photo links (15 minutes) for
//          that ONE submission only.
//   GET  ?action=photo&id=<id>&side=front|back&token=<signed token>
//        → streams the ID photo bytes. The token is HMAC-signed with the
//          staff secret and expires 15 minutes after it is issued.
//          This is the short-lived signed link — it is not a public URL and
//          it is not on the Bunny CDN.
//   POST ?action=pickedup  { id }   (secret required)
//        → marks a submission picked up: sets pickup_at + status. This is
//          what starts the 30-day retention clock (see intake-cleanup.js).
//
// Auth: send the secret as header X-Intake-Secret (preferred) or as
// ?secret=... . Do not share the secret with customers; do not put it in a
// link you send anyone.
//
// Env vars (Netlify, read only — never hardcode values here):
//   INTAKE_STAFF_SECRET (required — staff secret, Jonathan's own value)
//   WASABI_BUCKET, WASABI_REGION, WASABI_KEY, WASABI_SECRET
//   (WASABI_ENDPOINT optional override, else s3.<region>.wasabisys.com)
// No new dependency: @aws-sdk/client-s3 is already in package.json;
// tokens use Node's built-in crypto.

const crypto = require('crypto');
const { S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');

const PREFIX = 'intake-private';
const PHOTO_LINK_MINUTES = 15;

function wasabiClient() {
  const region = process.env.WASABI_REGION || 'us-east-1';
  const endpoint = process.env.WASABI_ENDPOINT || `https://s3.${region}.wasabisys.com`;
  return {
    client: new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.WASABI_KEY,
        secretAccessKey: process.env.WASABI_SECRET,
      },
    }),
    bucket: process.env.WASABI_BUCKET,
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function secretOk(event) {
  const configured = process.env.INTAKE_STAFF_SECRET;
  if (!configured) return false; // secret not set yet — refuse everything
  const q = (event.queryStringParameters || {});
  const given = event.headers['x-intake-secret'] || event.headers['X-Intake-Secret'] || q.secret || '';
  if (!given || given.length !== configured.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(configured));
  } catch (e) {
    return false;
  }
}

function cleanId(id) {
  const v = String(id || '').trim();
  // IDs are YYYY-MM-DD-<8 hex chars>, written by intake-submit.js only.
  if (!/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/.test(v)) return null;
  return v;
}

// Short-lived signed photo token: base64url({id, side, exp}) + HMAC(secret).
function signPhotoToken(id, side) {
  const exp = Date.now() + PHOTO_LINK_MINUTES * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ id, side, exp }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.INTAKE_STAFF_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyPhotoToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', process.env.INTAKE_STAFF_SECRET).update(payload).digest('base64url');
  let sigBuf;
  let expBuf;
  try {
    sigBuf = Buffer.from(sig, 'base64url');
    expBuf = Buffer.from(expected, 'base64url');
  } catch (e) {
    return null;
  }
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!data || !data.id || !data.side || !data.exp || Date.now() > data.exp) return null;
  return { id: cleanId(data.id), side: data.side === 'back' ? 'back' : 'front' };
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function getRecord(client, bucket, id) {
  const res = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: `${PREFIX}/${id}/record.json`,
  }));
  return JSON.parse((await streamToBuffer(res.Body)).toString('utf8'));
}

exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};
    const action = q.action || 'list';

    // Photo links carry their own signed token — no staff secret in the URL.
    if (action === 'photo') {
      if (!process.env.INTAKE_STAFF_SECRET) return json(503, { ok: false, error: 'Intake viewing is not set up yet.' });
      const v = verifyPhotoToken(q.token || '');
      if (!v || !v.id) return json(403, { ok: false, error: 'This photo link has expired or is not valid. Open the submission again from the staff list.' });
      const { client, bucket } = wasabiClient();
      const record = await getRecord(client, bucket, v.id);
      const file = (record.files || []).find((f) => f.startsWith(v.side === 'back' ? 'id-back.' : 'id-front.'));
      if (!file) return json(404, { ok: false, error: 'Photo not found for this submission.' });
      const res = await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: `${PREFIX}/${v.id}/${file}`,
      }));
      const buf = await streamToBuffer(res.Body);
      return {
        statusCode: 200,
        headers: {
          'Content-Type': res.ContentType || 'image/jpeg',
          'Cache-Control': 'no-store',
          'Content-Disposition': 'inline',
        },
        body: buf.toString('base64'),
        isBase64Encoded: true,
      };
    }

    // Every other action needs the staff secret.
    if (!secretOk(event)) {
      return json(403, { ok: false, error: 'Staff access only. Set the staff secret (INTAKE_STAFF_SECRET) in Netlify and send it with the request.' });
    }
    if (!process.env.WASABI_BUCKET || !process.env.WASABI_KEY || !process.env.WASABI_SECRET) {
      return json(503, { ok: false, error: 'Wasabi storage is not configured in Netlify yet.' });
    }
    const { client, bucket } = wasabiClient();

    if (action === 'list') {
      const ids = [];
      let token;
      do {
        const res = await client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `${PREFIX}/`,
          ContinuationToken: token,
        }));
        for (const obj of res.Contents || []) {
          const m = obj.Key.match(new RegExp(`^${PREFIX}/([^/]+)/record\\.json$`));
          if (m) ids.push(m[1]);
        }
        token = res.IsTruncated ? res.NextContinuationToken : null;
      } while (token);
      const items = [];
      for (const id of ids.sort().reverse()) {
        try {
          const r = await getRecord(client, bucket, id);
          // List carries metadata only — never the ID photo, never the pre-signature.
          items.push({
            id: r.id,
            fullName: r.fullName,
            product: r.product,
            orderRef: r.orderRef || '',
            pickupDay: r.pickupDay || '',
            submitted_at: r.submitted_at,
            pickup_at: r.pickup_at || null,
            status: r.status,
          });
        } catch (e) {
          console.error(`intake-view: unreadable record ${id}:`, e && e.message);
        }
      }
      return json(200, { ok: true, count: items.length, items });
    }

    if (action === 'detail') {
      const id = cleanId(q.id);
      if (!id) return json(400, { ok: false, error: 'A valid submission id is required.' });
      const r = await getRecord(client, bucket, id);
      const photos = {};
      for (const f of r.files || []) {
        const side = f.startsWith('id-back.') ? 'back' : 'front';
        photos[side] = `/.netlify/functions/intake-view?action=photo&id=${encodeURIComponent(id)}&side=${side}&token=${encodeURIComponent(signPhotoToken(id, side))}`;
      }
      return json(200, { ok: true, record: r, photos, photoLinkExpiresMinutes: PHOTO_LINK_MINUTES });
    }

    if (action === 'pickedup') {
      if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Use POST for pickedup.' });
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch (e) { /* fall through to id check */ }
      const id = cleanId(body.id || q.id);
      if (!id) return json(400, { ok: false, error: 'A valid submission id is required.' });
      const r = await getRecord(client, bucket, id);
      if (r.pickup_at) return json(200, { ok: true, id, pickup_at: r.pickup_at, status: r.status, note: 'Already marked picked up.' });
      r.pickup_at = new Date().toISOString();
      r.status = 'picked-up';
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: `${PREFIX}/${id}/record.json`,
        Body: Buffer.from(JSON.stringify(r, null, 2), 'utf8'),
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
      }));
      return json(200, { ok: true, id, pickup_at: r.pickup_at, status: r.status, note: 'Marked picked up. Record + ID photo will be deleted 30 days after pickup.' });
    }

    return json(400, { ok: false, error: 'Unknown action. Use action=list, detail, photo or pickedup.' });
  } catch (e) {
    console.error('intake-view error:', e && e.message);
    return json(500, { ok: false, error: 'Could not open the intake store. Check the Netlify function log.' });
  }
};
