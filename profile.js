'use strict';

// Profiling harness for the brute-force hot path in main.js.
//
// main.js runs unbounded (until all target hashes are found), which makes it
// useless to profile directly. This harness runs the *same* hot loop but with a
// fixed budget (a number of hashes to compute), so a profiling run always ends.
//
// It produces two things:
//   1. A live text report on stderr: throughput + where wall-clock time goes,
//      split between the two operations in the loop (SHA-256 vs. odometer
//      increment).
//   2. A V8 CPU profile written to ./profiles/<timestamp>.cpuprofile that you
//      can open in Chrome DevTools (Performance > Load profile) or on
//      https://www.speedscope.app to see the flame graph / hot path.
//
// Usage:
//   node profile.js                 # default: 20M hashes at word length 4
//   node profile.js --budget 5e7    # 50M hashes
//   node profile.js --length 5      # word length 5
//   node profile.js --no-cpuprofile # skip the .cpuprofile, text report only

const fs = require('node:fs');
const crypto = require('node:crypto');
const inspector = require('node:inspector');
const { performance } = require('node:perf_hooks');
const path = require('node:path');

const CHAR_PATH = './data/characters.txt';

// --- tiny arg parser -------------------------------------------------------
const args = process.argv.slice(2);
const getFlag = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const budget = Math.floor(Number(getFlag('--budget', '2e7')));   // # of hashes
const length = Number(getFlag('--length', '4'));                 // word length
const wantCpuProfile = !args.includes('--no-cpuprofile');

// --- setup (same as main.js) ----------------------------------------------
const bytes = fs
  .readFileSync(CHAR_PATH, 'utf8')
  .replace(/\n/g, '')
  .split('')
  .map((c) => c.charCodeAt(0));
const base = bytes.length;
const total = Math.min(budget, base ** length);

// --- optional V8 CPU profiler (programmatic, so we bound it exactly) --------
let session = null;
function startCpuProfile() {
  if (!wantCpuProfile) return;
  session = new inspector.Session();
  session.connect();
  const post = (method, params) =>
    new Promise((res, rej) =>
      session.post(method, params, (e, r) => (e ? rej(e) : res(r))));
  return post('Profiler.enable')
    .then(() => post('Profiler.setSamplingInterval', { interval: 100 })) // µs
    .then(() => post('Profiler.start'));
}
function stopCpuProfile() {
  if (!session) return Promise.resolve();
  return new Promise((resolve, reject) => {
    session.post('Profiler.stop', (err, { profile }) => {
      if (err) return reject(err);
      fs.mkdirSync('profiles', { recursive: true });
      const out = path.join(
        'profiles',
        `${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
      fs.writeFileSync(out, JSON.stringify(profile));
      const fg = out.replace(/\.cpuprofile$/, '.flamegraph.html');
      writeFlamegraph(profile, fg);
      session.disconnect();
      summarizeProfile(profile);
      console.error(`Flamegraph written to ${fg}`);
      console.error(`  open with: xdg-open ${fg}`);
      console.error(`\nCPU profile written to ${out}`);
      console.error('Open it in Chrome DevTools (Performance ▸ Load profile) or at https://www.speedscope.app');
      resolve();
    });
  });
}

// --- build a self-contained interactive flamegraph from a V8 profile ------
function writeFlamegraph(profile, outPath) {
  const { nodes, samples, timeDeltas } = profile;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // self time per node (microseconds), from the sample stream
  const selfUs = new Map();
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    selfUs.set(id, (selfUs.get(id) || 0) + (timeDeltas[i] || 0));
  }

  // find roots: nodes that are nobody's child
  const childIds = new Set();
  for (const n of nodes) for (const c of n.children || []) childIds.add(c);
  const roots = nodes.filter((n) => !childIds.has(n.id));

  // build a compact tree with total time (self + subtree), post-order
  const label = (cf) => {
    const name = cf.functionName || '(anonymous)';
    if (!cf.url) return { n: name, l: '(native)' };
    return { n: name, l: `${cf.url.split('/').pop()}:${cf.lineNumber + 1}` };
  };
  function build(id) {
    const node = byId.get(id);
    const self = selfUs.get(id) || 0;
    const kids = (node.children || []).map(build);
    const total = self + kids.reduce((a, k) => a + k.v, 0);
    const { n, l } = label(node.callFrame);
    return { n, l, s: self, v: total, c: kids };
  }
  let tree;
  if (roots.length === 1) {
    tree = build(roots[0].id);
  } else {
    const kids = roots.map((r) => build(r.id));
    tree = { n: '(all)', l: '', s: 0, v: kids.reduce((a, k) => a + k.v, 0), c: kids };
  }

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Flamegraph — profile.js</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --stroke:rgba(0,0,0,.25); }
  @media (prefers-color-scheme: dark){ :root:not([data-theme=light]){ --bg:#15171a; --fg:#e6e6e6; --muted:#9aa0a6; --stroke:rgba(255,255,255,.18);} }
  html,body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif}
  header{padding:12px 16px;border-bottom:1px solid var(--stroke)}
  h1{font-size:15px;margin:0 0 4px}
  .meta{color:var(--muted);font-size:12px}
  #chart{position:relative;margin:12px 16px}
  .frame{position:absolute;height:20px;box-sizing:border-box;border:1px solid var(--bg);
         border-radius:2px;overflow:hidden;white-space:nowrap;padding:0 4px;line-height:20px;
         font-size:11px;color:#111;cursor:pointer}
  .frame:hover{outline:1px solid var(--fg);outline-offset:-1px}
  #tip{position:fixed;pointer-events:none;background:var(--bg);border:1px solid var(--stroke);
       border-radius:6px;padding:6px 8px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.2);
       max-width:420px;display:none;z-index:10}
  #tip b{word-break:break-all}
  button{font:inherit;padding:3px 10px;border:1px solid var(--stroke);border-radius:6px;
         background:transparent;color:var(--fg);cursor:pointer}
</style></head>
<body>
<header>
  <h1>Flamegraph — SHA-256 brute-force hot path</h1>
  <div class="meta">Width = time spent (self + children). Click a frame to zoom, click Reset to zoom out. Hover for details.
  &nbsp; <button id="reset">Reset zoom</button></div>
</header>
<div id="chart"></div>
<div id="tip"></div>
<script>
const TREE = ${JSON.stringify(tree)};
const chart = document.getElementById('chart');
const tip = document.getElementById('tip');
const ROW = 21;
function color(name){ // stable warm palette by name hash
  let h=0; for(const ch of name) h=(h*31+ch.charCodeAt(0))>>>0;
  const hue=25+(h%35); const sat=70+(h%25); const lig=55+(h%12);
  return 'hsl('+hue+' '+sat+'% '+lig+'%)';
}
function fmt(us){ return us>=1000 ? (us/1000).toFixed(1)+' ms' : us.toFixed(0)+' µs'; }
function layout(root){
  chart.innerHTML='';
  const W = chart.clientWidth||800;
  const totalV = root.v||1;
  let maxDepth=0;
  (function draw(node,depth,x,w){
    maxDepth=Math.max(maxDepth,depth);
    const el=document.createElement('div');
    el.className='frame';
    el.style.left=x+'px'; el.style.width=Math.max(w,0.5)+'px';
    el.style.top=(depth*ROW)+'px';
    el.style.background=color(node.n);
    const pct=(node.v/totalV*100);
    el.textContent = w>34 ? node.n : '';
    el.onmousemove=(e)=>{ tip.style.display='block';
      tip.style.left=Math.min(e.clientX+12,innerWidth-430)+'px';
      tip.style.top=(e.clientY+12)+'px';
      tip.innerHTML='<b>'+node.n+'</b><br>'+node.l+'<br>total '+fmt(node.v)+' ('+pct.toFixed(1)+'%)<br>self '+fmt(node.s); };
    el.onmouseleave=()=>{ tip.style.display='none'; };
    el.onclick=()=>{ tip.style.display='none'; layout(node); };
    chart.appendChild(el);
    let cx=x;
    for(const k of (node.c||[]).slice().sort((a,b)=>b.v-a.v)){
      const kw=w*(k.v/node.v);
      draw(k,depth+1,cx,kw); cx+=kw;
    }
  })(root,0,0,W);
  chart.style.height=((maxDepth+1)*ROW+8)+'px';
}
document.getElementById('reset').onclick=()=>layout(TREE);
addEventListener('resize',()=>layout(TREE));
layout(TREE);
</script>
</body></html>`;
  fs.writeFileSync(outPath, html);
}

// --- summarize the captured profile: top functions by self time ----------
function summarizeProfile(profile) {
  const { nodes, samples, timeDeltas } = profile;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const selfUs = new Map(); // node id -> microseconds of self time
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    selfUs.set(id, (selfUs.get(id) || 0) + (timeDeltas[i] || 0));
  }
  const rows = [...selfUs.entries()]
    .map(([id, us]) => {
      const cf = byId.get(id).callFrame;
      const where = cf.url
        ? `${cf.url.split('/').pop()}:${cf.lineNumber + 1}`
        : '(native)';
      const name = cf.functionName || '(anonymous)';
      return { label: `${name}  ${where}`, us };
    })
    .sort((a, b) => b.us - a.us)
    .slice(0, 8);
  const totalUs = rows.reduce((s, r) => s + r.us, 0) +
    [...selfUs.values()].reduce((s, us) => s + us, 0) - rows.reduce((s, r) => s + r.us, 0);
  const grand = [...selfUs.values()].reduce((s, us) => s + us, 0) || 1;
  console.error('\n=== hot path (top self time from CPU profile) ===');
  for (const r of rows) {
    const pct = ((r.us / grand) * 100).toFixed(1).padStart(5);
    console.error(`${pct}%  ${(r.us / 1000).toFixed(0).padStart(6)} ms  ${r.label}`);
  }
  console.error('================================================');
}

// --- the hot loop, instrumented -------------------------------------------
// We measure hashing vs. odometer-increment separately using perf_hooks.
// Sampling every iteration would distort the numbers, so we time in blocks.
function run() {
  const word = Buffer.alloc(length, bytes[0]);
  const digits = new Array(length).fill(0);

  let hashNs = 0;
  let incNs = 0;
  const t0 = performance.now();

  const BLOCK = 1 << 16; // 65536 iterations per timed block
  let n = 0;
  while (n < total) {
    const end = Math.min(n + BLOCK, total);

    const hStart = performance.now();
    for (let k = n; k < end; k++) {
      crypto.createHash('sha256').update(word).digest();
      // increment inline so the hash timer captures only hashing:
      // (we re-do increment timing in the second pass below)
    }
    hashNs += performance.now() - hStart;

    // odometer increment for the same block, timed separately
    const iStart = performance.now();
    for (let k = n; k < end; k++) {
      for (let i = length - 1; i >= 0; i--) {
        if (++digits[i] < base) {
          word[i] = bytes[digits[i]];
          break;
        }
        digits[i] = 0;
        word[i] = bytes[0];
      }
    }
    incNs += performance.now() - iStart;

    n = end;
  }

  const wallMs = performance.now() - t0;
  return { wallMs, hashMs: hashNs, incMs: incNs, n };
}

// --- report ----------------------------------------------------------------
function report({ wallMs, hashMs, incMs, n }) {
  const rate = (n / (wallMs / 1000));
  const pct = (x) => `${((x / (hashMs + incMs)) * 100).toFixed(1)}%`;
  console.error('\n=== hot-path profile ===');
  console.error(`word length      : ${length}`);
  console.error(`hashes computed  : ${n.toLocaleString('en-US')}`);
  console.error(`wall time        : ${wallMs.toFixed(0)} ms`);
  console.error(`throughput       : ${(rate / 1e6).toFixed(2)} M hashes/s`);
  console.error(`  SHA-256        : ${hashMs.toFixed(0)} ms  (${pct(hashMs)})`);
  console.error(`  odometer inc   : ${incMs.toFixed(0)} ms  (${pct(incMs)})`);
  console.error('========================');
}

(async () => {
  await startCpuProfile();
  const stats = run();
  report(stats);
  await stopCpuProfile();
})();
