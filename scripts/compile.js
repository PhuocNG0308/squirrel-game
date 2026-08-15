/**
 * Compiles contracts/**\/*.hyp with the Hyperion compiler (@theqrl/hypc) and
 * writes artifacts (abi + bytecode) to build/.
 *
 * Differences from a Solidity/solc setup worth knowing:
 *  - `language` must be "Hyperion"; hypc rejects "Solidity" outright.
 *  - Output lives under `zvm` (Zond Virtual Machine), not `evm`.
 *  - The version pragma is `pragma hyperion >=0.0.1;`.
 */
const fs = require('fs');
const path = require('path');
const hypc = require('@theqrl/hypc');

const ROOT = path.join(__dirname, '..');
const CONTRACTS = path.join(ROOT, 'contracts');
const OUT = path.join(ROOT, 'build');
const ABI_DIR = path.join(ROOT, 'abi');

/** Our own contracts, as opposed to vendored OpenZeppelin. */
const OWN = ['QBTC', 'SquirrelGame', 'MiningFarm', 'Traits'];
const EIP170_LIMIT = 24576;

function collectSources(dir, base = '') {
  const sources = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(sources, collectSources(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.hyp')) {
      sources[rel] = { content: fs.readFileSync(path.join(dir, entry.name), 'utf8') };
    }
  }
  return sources;
}

function main() {
  const sources = collectSources(CONTRACTS);
  console.log(`hypc ${hypc.version()}`);
  console.log(`compiling ${Object.keys(sources).length} Hyperion sources...\n`);

  const input = {
    language: 'Hyperion',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        '*': { '*': ['abi', 'zvm.bytecode.object', 'zvm.deployedBytecode.object'] },
      },
    },
  };

  const output = JSON.parse(hypc.compile(JSON.stringify(input)));

  let fatal = false;
  for (const err of output.errors || []) {
    if (err.severity === 'error') { fatal = true; console.error(err.formattedMessage); }
    else if (!/SPDX/.test(err.formattedMessage)) {
      console.warn('warn:', err.formattedMessage.split('\n')[0]);
    }
  }
  if (fatal) process.exit(1);

  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(ABI_DIR, { recursive: true });

  const sizes = {};
  for (const [file, contracts] of Object.entries(output.contracts || {})) {
    for (const [name, c] of Object.entries(contracts)) {
      const bytecode = c.zvm && c.zvm.bytecode && c.zvm.bytecode.object;
      if (!bytecode) continue; // interface / abstract
      const artifact = {
        contractName: name,
        sourceName: file,
        compiler: { name: 'hypc', version: hypc.version() },
        abi: c.abi,
        bytecode: '0x' + bytecode,
        deployedBytecode: '0x' + c.zvm.deployedBytecode.object,
      };
      fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(artifact, null, 2));
      fs.writeFileSync(path.join(ABI_DIR, `${name}.json`), JSON.stringify(c.abi, null, 2));
      sizes[name] = {
        init: bytecode.length / 2,
        runtime: c.zvm.deployedBytecode.object.length / 2,
      };
    }
  }

  console.log('%s %s %s', 'contract'.padEnd(16), 'init'.padStart(8), 'runtime'.padStart(8));
  let over = false;
  for (const n of OWN) {
    if (!sizes[n]) { console.log('%s %s', n.padEnd(16), '   MISSING'); continue; }
    const flag = sizes[n].runtime > EIP170_LIMIT ? `  << EXCEEDS ${EIP170_LIMIT}` : '';
    if (flag) over = true;
    console.log('%s %s %s%s', n.padEnd(16),
      String(sizes[n].init).padStart(8), String(sizes[n].runtime).padStart(8), flag);
  }
  if (over) process.exit(1);

  console.log('\nartifacts -> build/, ABIs -> abi/');
}

main();
