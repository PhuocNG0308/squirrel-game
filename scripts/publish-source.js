/**
 * Publishes contract source to ZondScan so the deployed addresses show
 * verified code, a readable ABI, and working Read/Write tabs.
 *
 * The chain's JSON-RPC has nothing to do with this. Source verification is an
 * explorer service, and the public qrl_* proxy whitelists no compile or verify
 * method at all — see the probe notes in README. ZondScan runs the Hyperion
 * toolchain server side and exposes:
 *
 *   POST /api/contract/verify         -> { jobId }         (5 requests/min per IP)
 *   GET  /api/contract/verify/{jobId} -> pending | compiling | success | failed
 *   GET  /api/contract/compiler-info  -> selectable hypc builds
 *
 * Two things this script has to get right, both learned the hard way:
 *  - Send only the import closure of the contract being verified. Handing the
 *    runner all 39 sources (230KB) kills it: `hypc-runner produced invalid
 *    JSON: unexpected end of JSON input`. The closure is 6-20 files.
 *  - Pin `compilerVersion` to the build we compiled with locally. ZondScan
 *    defaults to a newer 0.2.0 build that emits different bytecode.
 */
const fs = require('fs');
const path = require('path');
const { Web3 } = require('@theqrl/web3');

const ROOT = path.join(__dirname, '..');
const CONTRACTS = path.join(ROOT, 'contracts');
const EXPLORER = 'https://zondscan.com';
const API = `${EXPLORER}/api/contract`;

/** Matches the hypc build in package.json; ZondScan's default is not it. */
const COMPILER = '0.0.2+commit.3e18e55d.Emscripten.clang';
/** Must mirror scripts/compile.js, or the bytecode will not match. */
const OPTIMIZER = { enabled: true, runs: 200 };
/** Submission rate limit is a bucket of 5, refilling 5 per minute. */
const SUBMIT_SPACING_MS = 13000;

const GITHUB_USER = 'PhuocNG0308';
const GITHUB_REPO = 'squirrel-game';
const EXTERNAL_URI = `https://github.com/${GITHUB_USER}/${GITHUB_REPO}`;

/** Reads one source relative to contracts/. */
const read = (rel) => fs.readFileSync(path.join(CONTRACTS, rel), 'utf8');

/**
 * Transitive import closure of a source file, keyed by its path relative to
 * contracts/ — the same shape the compiler saw, so `./lib/...` still resolves.
 */
function closure(entry) {
  const files = {};
  const stack = [entry];
  while (stack.length) {
    const rel = stack.pop();
    if (files[rel]) continue;
    const src = read(rel);
    files[rel] = src;
    for (const m of src.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
      const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      if (!files[dep]) stack.push(dep);
    }
  }
  return files;
}

/**
 * ABI-encoded constructor arguments, taken as the tail of the creation payload
 * so the encoding cannot drift from what deploy.js actually sent.
 */
function constructorArgs(web3, name, args) {
  if (!args.length) return '';
  const art = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', `${name}.json`), 'utf8'));
  const full = new web3.qrl.Contract(art.abi).deploy({ data: art.bytecode, arguments: args }).encodeABI();
  return full.slice(art.bytecode.length);
}

/** The exact request body the explorer expects, field for field. */
function buildPayload(web3, name, address, args) {
  const entry = `${name}.hyp`;
  const files = closure(entry);
  const imports = {};
  for (const [k, v] of Object.entries(files)) if (k !== entry) imports[k] = v;

  return {
    address,
    contractName: name,
    sourceCode: files[entry],
    compilerVersion: COMPILER,
    optimizerEnabled: OPTIMIZER.enabled,
    optimizerRuns: OPTIMIZER.runs,
    constructorArguments: constructorArgs(web3, name, args),
    license: 'MIT',
    imports,
  };
}

/**
 * Writes the payload out as the fields of the web form at
 * https://zondscan.com/verify-contract, for verifying by hand.
 */
function emit(web3, name, address, args) {
  const body = buildPayload(web3, name, address, args);
  const dir = path.join(ROOT, 'build', 'verify', name);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'source.hyp'), body.sourceCode);
  fs.writeFileSync(path.join(dir, 'imports.json'), JSON.stringify(body.imports, null, 0));
  // The whole request body, for posting directly instead of filling the form.
  fs.writeFileSync(path.join(dir, 'payload.json'), JSON.stringify(body));
  fs.writeFileSync(path.join(dir, 'fields.txt'), [
    `Compiler                : Hyperion ${COMPILER}`,
    `Contract address        : ${address}`,
    `Contract name           : ${name}`,
    `Optimizer               : Enabled`,
    `Optimizer runs          : ${OPTIMIZER.runs}`,
    `License                 : MIT`,
    `EVM version             : (leave empty)`,
    `Source code             : paste source.hyp`,
    `Imports                 : paste imports.json (${Object.keys(body.imports).length} files)`,
    `Constructor arguments   : ${body.constructorArguments ? '0x' + body.constructorArguments.replace(/^0x/, '') : '(none)'}`,
    '',
  ].join('\n'));

  const kb = (JSON.stringify(body).length / 1024).toFixed(1);
  console.log(`${name.padEnd(16)} -> build/verify/${name}/  (${kb} KiB total)`);
}

async function submit(web3, name, address, args) {
  const body = buildPayload(web3, name, address, args);
  const fileCount = Object.keys(body.imports).length + 1;

  const res = await fetch(`${API}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.jobId) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return { jobId: json.jobId, fileCount };
}

/** Whether the explorer already publishes source for this address. */
async function isVerified(address) {
  try {
    const agg = await (await fetch(`${EXPLORER}/api/address/aggregate/${address}`)).json();
    return JSON.stringify(agg).includes('"verified":true');
  } catch {
    return false;
  }
}

async function poll(jobId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const job = await (await fetch(`${API}/verify/${jobId}`)).json();
    if (job.status === 'success' || job.status === 'failed') return job;
  }
  return { status: 'timeout' };
}

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', 'testnet.json'), 'utf8'));
  const c = dep.contracts;
  const web3 = new Web3(dep.rpc);

  if (!dep.baseImageURI.includes(`${GITHUB_USER}/${GITHUB_REPO}`)) {
    throw new Error('baseImageURI does not match the GitHub constants in this script');
  }

  // Same arguments, in the same order, as scripts/deploy.js passed on chain.
  const plan = [
    ['QBTC', c.QBTC, []],
    ['Traits', c.Traits, [dep.baseImageURI, EXTERNAL_URI]],
    ['SquirrelGame', c.SquirrelGame, [c.QBTC, c.Traits, dep.maxTokens]],
    ['TraitStats', c.TraitStats, [c.SquirrelGame]],
    ['QuantumFarm', c.QuantumFarm, [c.SquirrelGame, c.QBTC]],
    ['RaidPost', c.RaidPost, [c.QuantumFarm, c.QBTC]],
    ['SeasonLedger', c.SeasonLedger, [c.QuantumFarm, c.RaidPost, c.QBTC]],
    ['Quests', c.Quests, [c.QuantumFarm, c.QBTC]],
    ['Fusion', c.Fusion, [c.SquirrelGame, c.TraitStats, c.QBTC]],
    ['SquirrelLens', c.SquirrelLens,
      [c.SquirrelGame, c.QuantumFarm, c.RaidPost, c.TraitStats]],
    ['ChunkedDeployer', c.ChunkedDeployer, []],
  ];

  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const force = process.argv.includes('--force');
  const queue = only.length ? plan.filter(([n]) => only.includes(n)) : plan;

  console.log(`ZondScan verification — hypc ${COMPILER}`);
  console.log(`optimizer ${OPTIMIZER.enabled ? `on, ${OPTIMIZER.runs} runs` : 'off'}\n`);

  if (process.argv.includes('--emit')) {
    for (const [name, address, args] of queue) if (address) emit(web3, name, address, args);
    console.log(`\nForm fields:  ${EXPLORER}/verify-contract  (see fields.txt)`);
    console.log('Or post the payload as-is:');
    console.log(`  curl -s -X POST ${API}/verify -H "Content-Type: application/json" \\`);
    console.log(`       --data-binary @build/verify/<Name>/payload.json`);
    return;
  }

  const results = [];
  let submitted = 0;
  for (const [name, address, args] of queue) {
    if (!address) { console.log(`${name.padEnd(16)} SKIP (not in deployments/testnet.json)`); continue; }
    if (!force && await isVerified(address)) {
      console.log(`${name.padEnd(16)} ${address}  already verified`);
      results.push([name, 'success']);
      continue;
    }
    if (submitted++ > 0) await new Promise((r) => setTimeout(r, SUBMIT_SPACING_MS));

    process.stdout.write(`${name.padEnd(16)} ${address}  `);
    try {
      const { jobId, fileCount } = await submit(web3, name, address, args);
      process.stdout.write(`${fileCount} files -> ${jobId} `);
      const job = await poll(jobId);
      const detail = job.status === 'success'
        ? (job.matchType ? `(${job.matchType})` : '')
        : (job.error || '').slice(0, 120);
      console.log(`${job.status.toUpperCase()} ${detail}`);
      results.push([name, job.status]);
    } catch (e) {
      console.log(`ERROR ${e.message}`);
      results.push([name, 'error']);
    }
  }

  const ok = results.filter(([, s]) => s === 'success').length;
  console.log(`\n${ok}/${results.length} verified — ${EXPLORER}/address/<address>`);
  for (const [name, status] of results) {
    if (status !== 'success') console.log(`  ! ${name}: ${status}`);
  }
  if (ok < results.length) {
    console.log('\nA FAILED job reading "hypc-runner produced invalid JSON" is a crash');
    console.log('inside ZondScan\'s compile worker, not a problem with this payload.');
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
