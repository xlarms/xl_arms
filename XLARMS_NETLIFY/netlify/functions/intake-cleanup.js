// intake-cleanup.js — XL Arms scheduled retention cleanup for pre-pickup intakes.
//
// Retention (Jonathan, 2026-11-05 — XL Arms' own policy, NOT an ATF rule):
// delete a submission's ID photo(s) + record 30 days after pickup_at if
// picked up, or 30 days after submitted_at if never picked up.
// The official Form 4473 signed in person is a separate ATF record in XL
// Arms' own acquisition/disposition log — it is NEVER in this store and
// this function never touches it.
//
// Safety: this function only ever deletes objects under the private
// intake-private/ prefix, and only the exact keys listed in a submission's
// own record.json (record + its ID photos). It never deletes anything else
// in the bucket — never product photos, never anything outside the prefix.
// Submissions with no readable record.json are logged and left alone.
//
// Schedule (in netlify.toml, same pattern as the existing schedulers):
//   [functions."intake-cleanup"]
//     schedule = "0 9 * * *"   — daily, 09:00 UTC (~04:00 EST / 05:00 EDT)
//
// Env vars (Netlify, read only — never hardcode values here):
//   WASABI_BUCKET, WASABI_REGION, WASABI_KEY, WASABI_SECRET
//   (WASABI_ENDPOINT optional override, else s3.<region>.wasabisys.com)
// No new dependency: @aws-sdk/client-s3 is already in package.json.

const { S3Client, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

const PREFIX = 'intake-private';
const RETENTION_DAYS = 30;

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

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

exports.handler = async () => {
  const now = Date.now();
  const result = { ok: true, checked: 0, deleted: 0, kept: 0, skipped: [], errors: [] };
  try {
    if (!process.env.WASABI_BUCKET || !process.env.WASABI_KEY || !process.env.WASABI_SECRET) {
      throw new Error('Missing Wasabi env vars — set WASABI_BUCKET, WASABI_KEY, WASABI_SECRET (and WASABI_REGION) in Netlify.');
    }
    const { client, bucket } = wasabiClient();

    // Find every submission record under the intake prefix only.
    const recordKeys = [];
    let token;
    do {
      const res = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${PREFIX}/`,
        ContinuationToken: token,
      }));
      for (const obj of res.Contents || []) {
        if (/^intake-private\/[^/]+\/record\.json$/.test(obj.Key)) recordKeys.push(obj.Key);
      }
      token = res.IsTruncated ? res.NextContinuationToken : null;
    } while (token);

    for (const key of recordKeys) {
      result.checked += 1;
      let record;
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        record = JSON.parse((await streamToBuffer(res.Body)).toString('utf8'));
      } catch (e) {
        result.skipped.push(`${key}: unreadable record, left alone (${e && e.message})`);
        continue;
      }
      const base = record.pickup_at || record.submitted_at;
      const baseMs = base ? Date.parse(base) : NaN;
      if (Number.isNaN(baseMs)) {
        result.skipped.push(`${key}: no submitted_at/pickup_at date, left alone`);
        continue;
      }
      const deadline = baseMs + RETENTION_DAYS * 24 * 60 * 60 * 1000;
      if (now <= deadline) {
        result.kept += 1;
        continue;
      }
      // Due for deletion: ONLY this submission's own keys, under the intake
      // prefix, as listed in its record. Nothing else in the bucket.
      const id = String(record.id || '').trim();
      if (!id || key !== `${PREFIX}/${id}/record.json`) {
        result.skipped.push(`${key}: id does not match its key, left alone`);
        continue;
      }
      const objects = [{ Key: key }];
      for (const f of record.files || []) {
        if (typeof f === 'string' && /^id-(front|back)\.(jpg|png|webp)$/.test(f)) {
          objects.push({ Key: `${PREFIX}/${id}/${f}` });
        }
      }
      await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
      result.deleted += 1;
      console.log(`intake-cleanup: deleted submission ${id} (${objects.length} objects, ${record.pickup_at ? 'picked up' : 'never picked up'}, over 30 days old)`);
    }

    console.log(`intake-cleanup done: checked ${result.checked}, deleted ${result.deleted}, kept ${result.kept}, skipped ${result.skipped.length}`);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (e) {
    console.error('intake-cleanup error:', e && e.message);
    result.ok = false;
    result.errors.push(e && e.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  }
};
