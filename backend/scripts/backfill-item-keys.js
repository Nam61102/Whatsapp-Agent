/**
 * One-time, idempotent backfill of ai_extractions.itemKey for rows saved before item keys existed.
 *
 *   node scripts/backfill-item-keys.js            # dry run: report only
 *   node scripts/backfill-item-keys.js --apply    # write keys (a JSON backup is written first)
 *
 * Run it BEFORE `prisma db push` adds the unique (messageId, itemKey) index.
 *
 * Only the itemKey field (and, when two rows cannot be told apart, a needsReview flag) is written.
 * Status, user edits, titles and dates are never touched, and no row is merged or deleted.
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { MongoClient } = require('mongodb');

const loose = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
const legacyKey = (type, title) =>
  'legacy-' + createHash('sha1').update(`${type}|${loose(title)}`).digest('hex').slice(0, 18);
const newKey = (type, excerpt) => createHash('sha1').update(`${type}|${loose(excerpt)}`).digest('hex').slice(0, 24);

(async () => {
  const apply = process.argv.includes('--apply');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const u = new URL(url);
  console.log(`target: ${u.hostname}:${u.port}/${u.pathname.slice(1)}  mode: ${apply ? 'APPLY' : 'dry run'}`);

  const client = new MongoClient(url);
  await client.connect();
  const col = client.db().collection('ai_extractions');

  const rows = await col.find({ $or: [{ itemKey: null }, { itemKey: { $exists: false } }] }).toArray();
  console.log(`rows without itemKey: ${rows.length}`);
  if (rows.length === 0) return client.close();

  // Keys already used per message, so a generated key never collides with an existing one.
  const used = new Map();
  for (const r of await col.find({ itemKey: { $type: 'string' } }).project({ messageId: 1, itemKey: 1 }).toArray()) {
    const k = String(r.messageId);
    if (!used.has(k)) used.set(k, new Set());
    used.get(k).add(r.itemKey);
  }

  const plan = [];
  for (const r of rows) {
    const msg = String(r.messageId);
    if (!used.has(msg)) used.set(msg, new Set());
    const taken = used.get(msg);
    // Prefer the saved excerpt (same identity a re-analysis would produce); otherwise the title.
    let key = r.supportingText ? newKey(r.extractionType, r.supportingText) : legacyKey(r.extractionType, r.title);
    let needsReview = false;
    if (taken.has(key)) {
      // Two rows of the same message look identical: keep both, make the key unique, flag for a human.
      key = `${key}-${String(r._id).slice(-6)}`;
      needsReview = true;
    }
    taken.add(key);
    plan.push({ _id: r._id, key, needsReview, status: r.status, title: r.title });
  }

  console.log(`to backfill: ${plan.length}, flagged for review: ${plan.filter((p) => p.needsReview).length}`);
  if (!apply) {
    plan.slice(0, 20).forEach((p) => console.log(`  ${p._id} [${p.status}] "${p.title}" -> ${p.key}${p.needsReview ? '  (needs review)' : ''}`));
    return client.close();
  }

  const backup = path.resolve(__dirname, `../scratch/ai_extractions.backup.${Date.now()}.json`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(backup, JSON.stringify(await col.find({}).toArray()));
  console.log(`backup written: ${backup}`);

  for (const p of plan) {
    const set = { itemKey: p.key };
    if (p.needsReview) set['structuredData.needsReview'] = true;
    await col.updateOne({ _id: p._id, $or: [{ itemKey: null }, { itemKey: { $exists: false } }] }, { $set: set });
  }
  console.log('done');
  await client.close();
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
