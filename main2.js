const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const CHAR_PATH = './data/characters.txt';
const DB_PATH = './data/words.db';
const HASHES_TO_FIND = ["a532ca5e11e2b06ccc911e0d962a4864cdb87da05723f3a050a376d0f0895e63", "bd7d0ea8cf7ade4a446ba4efc46fd99071ec3f423770991ac51f70ec5a894dc7", "b53fa215e4926b59eb5cabbbe57ca5f85062fa2117e5e949d1d48767f4c60cad"];

const MAX_LENGTH = 5;

const chars = fs.readFileSync(CHAR_PATH, 'utf8').replace(/\n/g, '');
const base = chars.length;

const start = Date.now();

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = OFF');
db.exec('PRAGMA synchronous = OFF');
db.exec('CREATE TABLE IF NOT EXISTS words (hash BLOB PRIMARY KEY, word TEXT) WITHOUT ROWID');

// --- Phase 1: store every word (length 1..MAX_LENGTH) and its hash on disk ---
// The DB lives on disk, so it is not bound by V8's ~16.7M Map cap. Building it
// still hashes every word once (~916M for length 5) and produces a large file.
const insert = db.prepare('INSERT OR IGNORE INTO words (hash, word) VALUES (?, ?)');

for (let length = 1; length <= MAX_LENGTH; length++) {
  const digits = new Array(length).fill(0);
  const total = base ** length;

  db.exec('BEGIN');
  for (let n = 0; n < total; n++) {
    let word = '';
    for (let i = 0; i < length; i++) word += chars[digits[i]];

    insert.run(crypto.createHash('sha256').update(word).digest(), word);
    if ((n & 0xfffff) === 0xfffff) { db.exec('COMMIT'); db.exec('BEGIN'); }

    for (let i = length - 1; i >= 0; i--) {
      if (++digits[i] < base) break;
      digits[i] = 0;
    }
  }
  db.exec('COMMIT');
  console.log(`length ${length} stored (${Date.now() - start} ms)`);
}

// --- Phase 2: find each target hash with a single indexed lookup ---
const lookup = db.prepare('SELECT word FROM words WHERE hash = ?');
for (const hash of HASHES_TO_FIND) {
  const row = lookup.get(Buffer.from(hash, 'hex'));
  console.log(`${hash} -> ${row ? `"${row.word}"` : '(not found)'} (${Date.now() - start} ms)`);
}
console.log(`done in ${Date.now() - start} ms`);
