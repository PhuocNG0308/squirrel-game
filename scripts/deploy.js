/**
 * Deploys the full Squirrel Game stack to QRL Zond testnet v2 (Hyperion).
 *
 * Order is forced by the constructor arguments: QBTC and Traits stand alone,
 * SquirrelGame needs both, TraitStats needs the collection, QuantumFarm needs
 * the collection and the token, and the satellites need the farm. Everything
 * that can only be pointed at after the fact is wired in step 10.
 */
const fs = require('fs');
const path = require('path');
const {
  connect, deploy, deployChunked, isOversized, send, sendRaw, saveDeployment, ROOT,
} = require('./qrl');

const GITHUB_USER = 'PhuocNG0308';
const GITHUB_REPO = 'squirrel-game';
const BASE_IMAGE_URI = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/assets/`;
const EXTERNAL_URI = `https://github.com/${GITHUB_USER}/${GITHUB_REPO}`;

const MAX_TOKENS = 50000; // Gen 0 allocation is MAX_TOKENS / 5 = 10,000

async function main() {
  // Deployment is irreversible and spends real testnet funds from the
  // deployer key, so it never runs by accident: pass --confirm explicitly.
  if (!process.argv.includes('--confirm')) {
    console.error('Refusing to deploy without explicit confirmation.');
    console.error('Review first:    npm run economics && npm test');
    console.error('Then deploy:     npm run deploy -- --confirm');
    process.exit(1);
  }

  const { web3, account, env } = connect();
  const balance = await web3.qrl.getBalance(account.address);

  console.log('network  :', env.QRL_RPC_URL);
  console.log('chainId  :', (await web3.qrl.getChainId()).toString());
  console.log('deployer :', account.address);
  console.log('balance  :', Number(balance) / 1e18, 'QRL');
  console.log('base URI :', BASE_IMAGE_URI);
  console.log();

  const step = (n, label) => console.log(`[${n}/11] ${label}`);
  const at = (name, c) => console.log(`       ${name.padEnd(14)} ${c.options.address}`);

  /**
   * Deploys directly when the creation payload fits, and falls back to
   * uploading it in pieces when it does not.
   *
   * QRL's ML-DSA-87 signatures add ~7.2KB to every transaction and the public
   * proxy caps a body at 50KB, which leaves roughly 18KB for creation code —
   * far below the 24,576 bytes the chain itself allows. SquirrelGame and
   * QuantumFarm are both valid contracts that simply cannot arrive in one
   * request.
   */
  let helper;
  const put = async (name, args, gas, opts) => {
    if (!isOversized(web3, name, args)) return deploy(web3, account, name, args, gas);
    if (!helper) {
      console.log('       payload limit exceeded; bringing up ChunkedDeployer');
      helper = await deploy(web3, account, 'ChunkedDeployer', [], 1200000);
      console.log(`       ChunkedDeployer ${helper.options.address}`);
    }
    console.log(`       ${name} uploading in chunks`);
    return deployChunked(web3, account, helper.options.address, name, args, gas, opts);
  };

  step(1, 'QBTC');
  const qbtc = await put('QBTC', [], 2500000);
  at('QBTC', qbtc);

  step(2, 'Traits');
  const traits = await put('Traits', [BASE_IMAGE_URI, EXTERNAL_URI], 5500000);
  at('Traits', traits);

  step(3, 'SquirrelGame');
  const game = await put('SquirrelGame', [qbtc.options.address, traits.options.address, MAX_TOKENS], 13000000);
  at('SquirrelGame', game);

  step(4, 'TraitStats');
  const stats = await put('TraitStats', [game.options.address], 3500000);
  at('TraitStats', stats);

  step(5, 'QuantumFarm');
  const farm = await put('QuantumFarm', [game.options.address, qbtc.options.address], 9000000);
  at('QuantumFarm', farm);

  step(6, 'RaidPost');
  const post = await put('RaidPost', [farm.options.address, qbtc.options.address], 4500000);
  at('RaidPost', post);

  step(7, 'SeasonLedger');
  const ledger = await put('SeasonLedger', [farm.options.address, post.options.address, qbtc.options.address], 3000000);
  at('SeasonLedger', ledger);

  step(8, 'Quests');
  const quests = await put('Quests', [farm.options.address, qbtc.options.address], 4500000);
  at('Quests', quests);

  step(9, 'Fusion');
  const fusion = await put('Fusion', [game.options.address, stats.options.address, qbtc.options.address], 3000000);
  at('Fusion', fusion);

  step(10, 'SquirrelLens');
  const lens = await put('SquirrelLens', [
    game.options.address, farm.options.address, post.options.address, stats.options.address,
  ], 8000000);
  at('SquirrelLens', lens);

  step(11, 'wiring');
  /**
   * Signs locally rather than letting web3 choose a path.
   *
   * A contract built as `new Contract(abi, address)` — which is what
   * deployChunked returns — is not bound to the local wallet, so web3 falls
   * back to `qrl_sendTransaction` and asks the node to sign. The public proxy
   * refuses that method, so every wiring call has to be signed here.
   */
  const wire = async (label, target, tx, gas = 220000) => {
    await sendRaw(web3, account, { to: target, data: tx.encodeABI(), gas });
    console.log(`       ${label}`);
  };

  const G = game.options.address;
  const T = traits.options.address;
  const F = farm.options.address;
  const P = post.options.address;
  const Q = qbtc.options.address;

  await wire('game.setFarm', G, game.methods.setFarm(F));
  await wire('game.setFusionForge', G, game.methods.setFusionForge(fusion.options.address));
  await wire('traits.setGame', T, traits.methods.setGame(G));
  await wire('traits.setStats', T, traits.methods.setStats(stats.options.address));
  await wire('farm.setRaidPost', F, farm.methods.setRaidPost(P));
  await wire('farm.setStats', F, farm.methods.setStats(stats.options.address));
  await wire('post.setStats', P, post.methods.setStats(stats.options.address));

  // Contracts allowed to charge a fee against a player's in-game credit, and
  // the forge's back-reference so it can do so.
  await wire('farm.setSpender fusion', F, farm.methods.setSpender(fusion.options.address, true));
  await wire('farm.setSpender raidPost', F, farm.methods.setSpender(P, true));
  await wire('fusion.setFarm', fusion.options.address, fusion.methods.setFarm(F));

  // Every contract that mints or burns qBTC needs the controller role.
  for (const [label, addr] of [
    ['farm', F],
    ['game', G],
    ['raidPost', P],
    ['seasonLedger', ledger.options.address],
    ['quests', quests.options.address],
    ['fusion', fusion.options.address],
  ]) {
    await wire(`qbtc.addController ${label}`, Q, qbtc.methods.addController(addr));
  }

  console.log('\n[+] seeding trait metadata');
  const names = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'trait-names.json'), 'utf8'));
  await wire(`uploadTraitTypes (${names.length} slots)`, T,
    traits.methods.uploadTraitTypes(names.map((n) => n.slot), names.map((n) => n.trait)),
    2500000);

  const bTypes = [], bIndices = [], bValues = [];
  for (const n of names) {
    n.values.forEach((v, i) => { bTypes.push(n.slot); bIndices.push(i); bValues.push(v); });
  }
  await wire(`uploadTraitsBatch (${bValues.length} values)`, T,
    traits.methods.uploadTraitsBatch(bTypes, bIndices, bValues), 6000000);

  const deployment = {
    network: 'QRL Zond testnet v2 (Hyperion)',
    rpc: env.QRL_RPC_URL,
    chainId: 1337,
    deployer: account.address,
    deployedAt: new Date().toISOString(),
    baseImageURI: BASE_IMAGE_URI,
    maxTokens: MAX_TOKENS,
    paidTokens: MAX_TOKENS / 5,
    contracts: {
      QBTC: qbtc.options.address,
      Traits: traits.options.address,
      SquirrelGame: game.options.address,
      TraitStats: stats.options.address,
      QuantumFarm: farm.options.address,
      RaidPost: post.options.address,
      SeasonLedger: ledger.options.address,
      Quests: quests.options.address,
      Fusion: fusion.options.address,
      SquirrelLens: lens.options.address,
    },
  };
  saveDeployment(deployment);

  console.log('\n=== DEPLOYED ===');
  console.table(deployment.contracts);
  console.log('saved -> deployments/testnet.json');
}

main().catch((e) => { console.error('\nDEPLOY FAILED:', e.message || e); process.exit(1); });
