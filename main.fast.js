'use strict';

// Optimized brute-force SHA-256 word finder.
//
// Baseline: main.js. This version applies the three findings from the CPU
// profile (see profile.js):
//
//   1. GC dominated (~40%): main.js calls crypto.createHash('sha256') every
//      iteration, allocating a fresh Hash object graph that the GC then has to
//      reclaim. We replace it with the one-shot crypto.hash() (Node 21.7+/20.12+),
//      which computes the digest without a per-iteration JS Hash object.
//
//   2. Redundant work in the check: main.js rebuilt a Hash object AND did a
//      Map .has()+.get() every iteration. We keep the fast hex digest and test
//      it against a Set of the targets with a single .has() (measured fastest
//      here; Buffer output + byte compare was ~4x slower in this build).
//
//   3. Single-threaded: main.js used one core. We split each length's search
//      space across all cores with worker_threads, round-robin (worker i takes
//      indices i, i+N, i+2N, ...). For finding a single word, striping lets the
//      worker that owns the target reach it in index/N steps instead of having
//      15 cores scan index ranges the answer isn't in.

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const {
  Worker, isMainThread, parentPort, workerData,
} = require('node:worker_threads');

const CHAR_PATH = './data/characters.txt';
const HASHES_TO_FIND = [
  'a532ca5e11e2b06ccc911e0d962a4864cdb87da05723f3a050a376d0f0895e63',
  'bd7d0ea8cf7ade4a446ba4efc46fd99071ec3f423770991ac51f70ec5a894dc7',
  'b53fa215e4926b59eb5cabbbe57ca5f85062fa2117e5e949d1d48767f4c60cad',
];

// Alphabet, shared by every thread.
const bytes = fs
  .readFileSync(CHAR_PATH, 'utf8')
  .replace(/\n/g, '')
  .split('')
  .map((c) => c.charCodeAt(0));
const base = bytes.length;

if (isMainThread) {
  runMain();
} else {
  runWorker();
}

// ---------------------------------------------------------------------------
// Worker: scans a contiguous slice [start, start+count) of one length's space.
// ---------------------------------------------------------------------------
function runWorker() {
  // The digest is compared as a hex string: in this Node build crypto.hash()
  // with hex output is ~2.6x faster than any Buffer-returning variant, so a
  // plain Set lookup beats byte comparison.
  const targetSet = new Set(workerData.targets);
  parentPort.on('message', (job) => scan(job, targetSet));
}

function scan({ length, offset, stride, count }, targetSet) {
  const word = Buffer.alloc(length, bytes[0]);
  const digits = new Array(length).fill(0);

  // Seed the odometer at this worker's first index (= offset).
  let rem = offset;
  for (let i = length - 1; i >= 0; i--) {
    digits[i] = rem % base;
    word[i] = bytes[digits[i]];
    rem = Math.floor(rem / base);
  }

  for (let n = 0; n < count; n++) {
    // One-shot hex hash -> no per-iteration Hash object (GC churn gone) and the
    // fastest digest path in this runtime.
    const digest = crypto.hash('sha256', word);
    if (targetSet.has(digest)) {
      parentPort.postMessage({
        type: 'found',
        hash: digest,
        word: word.toString('latin1'),
      });
    }

    // Advance the odometer by `stride` (base-62 add-with-carry). Carry rarely
    // propagates past the lowest digit, so this stays ~O(1) amortized.
    let carry = stride;
    for (let i = length - 1; i >= 0 && carry > 0; i--) {
      const v = digits[i] + carry;
      digits[i] = v % base;
      carry = (v - digits[i]) / base;
      word[i] = bytes[digits[i]];
    }
  }

  parentPort.postMessage({ type: 'done' });
}

// ---------------------------------------------------------------------------
// Main: spawns a pool, then walks lengths 1,2,3,... splitting each across it.
// ---------------------------------------------------------------------------
function runMain() {
  const remaining = new Map(HASHES_TO_FIND.map((hash) => [hash, null]));
  // Default: all logical CPUs. SHA-256 is compute-bound and saturates the
  // cores, so on an SMT machine (e.g. 8 cores / 16 threads) the extra threads
  // only add contention -- WORKERS=<physical core count> is measurably faster
  // (here ~17.5s vs ~27.6s). Override with the WORKERS env var.
  const nWorkers = Number(process.env.WORKERS) || os.availableParallelism();
  const workers = [];
  const start = Date.now();
  let length = 0;
  let doneCount = 0;
  let finished = false;

  const dispatchLength = (len) => {
    doneCount = 0;
    // base ** len stays exact through length 8 (62**8 < 2**53); deeper would
    // need BigInt indexing.
    const total = base ** len;
    for (let i = 0; i < nWorkers; i++) {
      // Worker i scans indices i, i+nWorkers, i+2*nWorkers, ... < total.
      const count = i < total ? Math.floor((total - 1 - i) / nWorkers) + 1 : 0;
      workers[i].postMessage({
        type: 'scan', length: len, offset: i, stride: nWorkers, count,
      });
    }
  };

  for (let i = 0; i < nWorkers; i++) {
    const w = new Worker(__filename, { workerData: { targets: HASHES_TO_FIND } });
    w.on('message', (msg) => {
      if (finished) return;

      if (msg.type === 'found') {
        if (remaining.get(msg.hash) === null) {
          remaining.set(msg.hash, msg.word);
          console.log(`found "${msg.word}" -> ${msg.hash} (${Date.now() - start} ms)`);
          for (const v of remaining.values()) if (v === null) return;
          finished = true;
          console.log(`all hashes found in ${Date.now() - start} ms`);
          for (const worker of workers) worker.terminate();
        }
      } else if (msg.type === 'done') {
        if (++doneCount === nWorkers) dispatchLength(++length);
      }
    });
    workers.push(w);
  }

  dispatchLength(++length);
}
