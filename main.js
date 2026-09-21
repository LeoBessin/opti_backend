const fs = require('node:fs');
const crypto = require('node:crypto');

const CHAR_PATH = './data/characters.txt';
const HASHES_TO_FIND =["a532ca5e11e2b06ccc911e0d962a4864cdb87da05723f3a050a376d0f0895e63", "bd7d0ea8cf7ade4a446ba4efc46fd99071ec3f423770991ac51f70ec5a894dc7"];

const bytes = fs.readFileSync(CHAR_PATH, 'utf8').replace(/\n/g, '').split('').map((c) => c.charCodeAt(0));
const base = bytes.length;

const remaining = new Map(HASHES_TO_FIND.map((hash) => [hash, null]));

const scanLength = (length) => {
  const word = Buffer.alloc(length, bytes[0]);
  const digits = new Array(length).fill(0);
  const total = base ** length;

  for (let n = 0; n < total; n++) {
    const hash = crypto.createHash('sha256').update(word).digest('hex');
    if (remaining.has(hash) && remaining.get(hash) === null) {
      const found = word.toString('latin1');
      remaining.set(hash, found);
      console.log(`found "${found}" -> ${hash} (${Date.now() - start} ms)`);
    }

    for (let i = length - 1; i >= 0; i--) {
      if (++digits[i] < base) {
        word[i] = bytes[digits[i]];
        break;
      }
      digits[i] = 0;
      word[i] = bytes[0];
    }
  }
};

const start = Date.now();

for (let length = 1; ; length++) {
  scanLength(length);

  const found = [...remaining.values()].filter((word) => word !== null);
  if (found.length === HASHES_TO_FIND.length) {
    console.log(`all hashes found in ${Date.now() - start} ms`);
    break;
  }
}
