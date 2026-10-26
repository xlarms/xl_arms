// Manifest rebuild: Wasabi staging -> live image prefix -> Blobs manifest.
// NO FTP AT ALL. Built 2026-10-26 because RSR's FTPS data connections die
// intermittently (see image-sync-background.js), while Jonathan already
// holds the standard-photo tree on an external drive (Nov 2025 snapshot:
// ftp_images/rsr_number/<shard>/<SKU>_<n>.jpg + new_images/, NO high-res).
//
// How it is used:
//   1. Jonathan bulk-uploads the drive's shard folders (the folders INSIDE
//      rsr_number/, plus the new_images/ folder) into Wasabi with a plain
//      folder copy (Cyberduck etc.) under the staging prefix, e.g.:
//        products-staging/a/AZ16119_1.jpg
//        products-staging/new_images/XX1234_1.jpg
//      Do NOT upload categories/ or manufacturers/ (the site's tiles are
//      already set) and do NOT touch the old site's ftp_images/ tree.
//   2. After the upload, trigger one shard at a time (same discipline as
//      the FTP sync — never two manifest writers at once):
//        /.netlify/functions/image-manifest-rebuild-background?shard=a
//        ... ?shard=b ... ?shard=num ... ?shard=%23  ('#' must be encoded)
//        /.netlify/functions/image-manifest-rebuild-background?new-images=1
//   OR skip the upload entirely with ?source=bucket (added 2026-10-26
//   when Jonathan caught the redundancy mid-transfer): the same standard
//   photos already live in this bucket under the old site's ftp_images/
//   tree, so the function can copy straight from there —
//   ftp_images/rsr_number/<shard>/ (or ftp_images/new_images/) — into
//   the live layout, with no drive upload at all:
//        /.netlify/functions/image-manifest-rebuild-background?shard=a&source=bucket
//   Whether the bucket tree covers every product is unproven (it is a
//   snapshot from whenever it was last filled); the rebuild log's
//   skusCopied count shows it per shard, and staging (drive) remains as
//   the gap-fill source for any shard that comes up short.
//   3. The function server-side-copies each staged file into the live
//      layout the storefront serves — <prefix>/<SKU>/<n>.jpg, i.e. the
//      shard folder is dropped and <SKU>_<n>.jpg is split into a folder
//      plus a number — and records it in the Blobs manifest, so product
//      pages start showing the photos. No bytes are downloaded anywhere.
//
// Rules it follows:
//   - Numbering is gapless per SKU, like the FTP sync: only the 1,2,3...
//     prefix is copied; files past a numbering gap are skipped (logged).
//   - Existing hi-res entries are PRESERVED: the drive has no hi files, so
//     this function never touches hiCount/hiSizes (FTP sync still owns hi).
//   - A SKU whose standard sizes changed vs the manifest gets its Bunny
//     prefix purged (same as the FTP sync); brand-new SKUs need no purge.
//   - A copy failure on one SKU never kills the run; 20 straight copy
//     failures aborts it (e.g. bad credentials), still saving the manifest
//     with progress so far.
//
// Env vars (same Wasabi vars as the image sync; NEVER in chat or code):
//   WASABI_BUCKET, WASABI_KEY, WASABI_SECRET (secret), WASABI_REGION
//   WASABI_ENDPOINT      (optional override, else s3.<region>.wasabisys.com)
//   WASABI_PREFIX        (live target, default 'products')
//   WASABI_STAGING_PREFIX (upload target, default 'products-staging')
//   BUNNY_HOSTNAME       (purge only; rebuild works without it)
//   BUNNY_API_KEY        (optional — purge only)
const MAX_IMAGES_PER_SKU = 10;

function wasabiClient() {
  let s3;
  try {
    s3 = require('@aws-sdk/client-s3');
  } catch {
    throw new Error('@aws-sdk/client-s3 is not installed — add it to package.json and redeploy before triggering the manifest rebuild.');
  }
  const region = process.env.WASABI_REGION || 'us-east-1';
  const endpoint = process.env.WASABI_ENDPOINT || `https://s3.${region}.wasabisys.com`;
  return {
    client: new s3.S3Client({
      region,
      endpoint,
      credentials: { accessKeyId: process.env.WASABI_KEY, secretAccessKey: process.env.WASABI_SECRET },
      forcePathStyle: false,
    }),
    ListObjectsV2Command: s3.ListObjectsV2Command,
    CopyObjectCommand: s3.CopyObjectCommand,
    bucket: process.env.WASABI_BUCKET,
  };
}

async function bunnyPurgePrefix(hostname, prefix, sku) {
  const apiKey = process.env.BUNNY_API_KEY;
  if (!apiKey || !hostname) return 'skipped (no BUNNY_API_KEY or BUNNY_HOSTNAME)';
  const url = `https://${hostname}/${prefix}/${sku}/*`;
  const res = await fetch(`https://api.bunny.net/purge?url=${encodeURIComponent(url)}&async=true`, {
    method: 'POST',
    headers: { AccessKey: apiKey },
  });
  if (!res.ok) throw new Error(`Bunny purge ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200));
  return 'purged';
}

async function loadManifest(blobs) {
  try {
    const store = blobs.getStore('xl-arms-catalog');
    const m = await store.get('images.json', { type: 'json' });
    if (m && m.images && typeof m.images === 'object') return m;
  } catch (e) { console.warn('No prior image manifest, starting fresh:', e.message); }
  return { generated: null, prefix: null, hiPrefix: null, images: {} };
}

async function listAllKeys(s3, ListObjectsV2Command, bucket, prefix) {
  const keys = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token }));
    for (const obj of (res.Contents || [])) {
      if (obj && obj.Key) keys.push({ key: obj.Key, size: obj.Size || 0 });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

exports.handler = async (event) => {
  // Background function: Netlify returns 202 immediately; progress is in
  // the Functions log. The caller does NOT see this summary in the response.
  try {
    const qs = event.queryStringParameters || {};
    const prefix = process.env.WASABI_PREFIX || 'products';
    const staging = process.env.WASABI_STAGING_PREFIX || 'products-staging';
    const hostname = process.env.BUNNY_HOSTNAME || '';
    if (!process.env.WASABI_BUCKET || !process.env.WASABI_KEY || !process.env.WASABI_SECRET) {
      throw new Error('Missing Wasabi env vars — set WASABI_BUCKET, WASABI_KEY, WASABI_SECRET (and WASABI_REGION) in Netlify, then redeploy.');
    }
    const { client: s3, ListObjectsV2Command, CopyObjectCommand, bucket } = wasabiClient();

    // Decide the source: one shard, or the new_images folder. The listing
    // tries the plain staging layout first, then the layout you get if the
    // whole rsr_number/ (or ftp_images/) folder was dragged in instead.
    // With ?source=bucket the existing bucket tree is the source instead.
    const fromBucket = qs.source === 'bucket';
    let mode, candidates;
    if (qs['new-images']) {
      mode = 'new-images';
      candidates = fromBucket
        ? [`ftp_images/new_images/`]
        : [`${staging}/new_images/`, `${staging}/ftp_images/new_images/`];
    } else if (qs.shard) {
      const shard = String(qs.shard).toLowerCase();
      mode = `shard:${shard}`;
      candidates = fromBucket
        ? [`ftp_images/rsr_number/${shard}/`]
        : [`${staging}/${shard}/`, `${staging}/rsr_number/${shard}/`, `${staging}/ftp_images/rsr_number/${shard}/`];
    } else {
      throw new Error('Pass ?shard=<a-z,num,#> (use %23 for #) or ?new-images=1.');
    }
    let sourcePrefix = null;
    let staged = [];
    for (const cand of candidates) {
      const found = await listAllKeys(s3, ListObjectsV2Command, bucket, cand);
      if (found.length > 0) { sourcePrefix = cand; staged = found; break; }
    }
    if (!sourcePrefix) {
      throw new Error(fromBucket
        ? `Nothing found in the bucket's ftp_images/ tree for ${mode} — that shard may genuinely have no photos there (drive staging can fill gaps).`
        : `Nothing found under staging for ${mode} — upload the shard folders into Wasabi '${staging}/' first (see file header).`);
    }

    let blobs;
    try { blobs = require('@netlify/blobs'); } catch {
      throw new Error('@netlify/blobs is not installed.');
    }
    try { blobs.connectLambda(event); } catch (e) { console.warn('connectLambda skipped:', e.message); }
    const manifest = await loadManifest(blobs);
    manifest.prefix = prefix;
    if (!manifest.hiPrefix) manifest.hiPrefix = prefix + '-hi';

    // Group staged files by SKU. The basename pattern is folder-agnostic,
    // so rsr_number/<shard>/ and new_images/ (flat or nested) both work.
    const bySku = new Map();
    for (const { key, size } of staged) {
      const base = key.split('/').pop();
      const m = base.match(/^(.+?)_(\d+)\.jpg$/i);
      if (!m) continue; // not a product photo (e.g. a category tile) — skip
      const sku = m[1];
      const n = parseInt(m[2], 10);
      if (!bySku.has(sku)) bySku.set(sku, new Map());
      bySku.get(sku).set(n, { key, size });
    }

    const results = [];
    let consecutiveCopyErrors = 0;
    let abortErr = null;
    let filesCopied = 0;
    let bytesCopied = 0;
    let skippedBeyondGap = 0;
    for (const sku of [...bySku.keys()].sort()) {
      try {
        const nums = bySku.get(sku);
        // Gapless prefix only: 1,2,3... until the first missing number.
        const sizes = [];
        const toCopy = [];
        for (let n = 1; n <= MAX_IMAGES_PER_SKU; n++) {
          if (!nums.has(n)) break;
          toCopy.push({ n, ...nums.get(n) });
          sizes.push(nums.get(n).size);
        }
        skippedBeyondGap += [...nums.keys()].filter((n) => n > sizes.length).length;
        if (toCopy.length === 0) { results.push({ sku, status: 'no-gapless-images' }); continue; }
        for (const f of toCopy) {
          const copySource = `${bucket}/${f.key.split('/').map(encodeURIComponent).join('/')}`;
          await s3.send(new CopyObjectCommand({
            Bucket: bucket,
            CopySource: copySource,
            Key: `${prefix}/${sku}/${f.n}.jpg`,
            ContentType: 'image/jpeg',
            MetadataDirective: 'REPLACE',
          }));
          filesCopied++;
          bytesCopied += f.size;
        }
        const prev = manifest.images[sku];
        const changed = !!prev && prev.sizes && JSON.stringify(prev.sizes) !== JSON.stringify(sizes);
        let purge = 'n/a (new SKU, nothing cached yet)';
        if (changed) {
          try { purge = await bunnyPurgePrefix(hostname, prefix, sku); }
          catch (e) { purge = `FAILED (logged, rebuild continues): ${e.message}`; }
        }
        // Hi entries are preserved untouched — this function never owns hi.
        manifest.images[sku] = {
          count: sizes.length,
          sizes,
          hiCount: (prev && prev.hiCount) || 0,
          hiSizes: (prev && prev.hiSizes) || [],
        };
        results.push({ sku, status: 'ok', count: sizes.length, changed, purge });
        consecutiveCopyErrors = 0;
      } catch (e) {
        results.push({ sku, status: 'error', error: e.message });
        consecutiveCopyErrors++;
        if (consecutiveCopyErrors >= 20) { abortErr = e; break; }
      }
    }

    manifest.generated = new Date().toISOString();
    await blobs.getStore('xl-arms-catalog').set('images.json', JSON.stringify(manifest));
    const ok = results.filter((r) => r.status === 'ok');
    console.log('Manifest rebuild OK', JSON.stringify({
      mode, source: fromBucket ? 'bucket' : 'staging', sourcePrefix, targetPrefix: prefix,
      skusCopied: ok.length, filesCopied, bytesCopied, skippedBeyondGap,
      purged: ok.filter((r) => r.changed).map((r) => r.sku),
      errors: results.filter((r) => r.status === 'error'),
      aborted: !!abortErr,
    }));
    if (abortErr) {
      console.error('Manifest rebuild ABORTED after 20 consecutive copy failures:', abortErr.message);
      return { statusCode: 202, body: JSON.stringify({ ok: false, error: 'Aborted: ' + abortErr.message }) };
    }
    return { statusCode: 202, body: JSON.stringify({ ok: true, note: 'Background manifest rebuild started — check Functions log for Manifest rebuild OK.' }) };
  } catch (e) {
    console.error('Manifest rebuild FAILED:', e.message);
    return { statusCode: 202, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
