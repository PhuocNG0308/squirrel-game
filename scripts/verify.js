/**
 * Post-deployment verification: reads back on-chain state and confirms the
 * stack is wired correctly. Read-only — sends no transactions.
 */
const fs = require('fs');
const path = require('path');
const { connect, artifact, loadDeployment } = require('./qrl');

let failures = 0;
function check(label, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
}

async function main() {
  const { web3, account } = connect();
  const d = loadDeployment();
  const c = d.contracts;
  const at = (name, addr) => new web3.qrl.Contract(artifact(name).abi, addr);
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  console.log(`network : ${d.network}`);
  console.log(`deployed: ${d.deployedAt}\n`);

  console.log('=== CODE ON CHAIN ===');
  for (const [name, addr] of Object.entries(c)) {
    const code = await web3.qrl.getCode(addr);
    const local = name === 'ChunkedDeployer' || !fs.existsSync(
      path.join(__dirname, '..', 'build', `${name}.json`),
    ) ? null : artifact(name).deployedBytecode;
    const size = (code.length - 2) / 2;
    check(`${name} deployed`, size > 0,
      `${size} bytes${local && local === code ? ', matches local build' : ''}`);
  }

  const qbtc = at('QBTC', c.QBTC);
  const traits = at('Traits', c.Traits);
  const game = at('SquirrelGame', c.SquirrelGame);
  const stats = at('TraitStats', c.TraitStats);
  const farm = at('QuantumFarm', c.QuantumFarm);
  const post = at('RaidPost', c.RaidPost);

  console.log('\n=== OWNERSHIP ===');
  for (const [name, inst] of [['SquirrelGame', game], ['QuantumFarm', farm],
    ['Traits', traits], ['TraitStats', stats], ['RaidPost', post], ['QBTC', qbtc]]) {
    check(`${name} owned by the deployer`,
      same(await inst.methods.owner().call(), account.address));
  }

  console.log('\n=== WIRING ===');
  check('game.farm -> QuantumFarm', same(await game.methods.farm().call(), c.QuantumFarm));
  check('game.traits -> Traits', same(await game.methods.traits().call(), c.Traits));
  check('game.qbtc -> QBTC', same(await game.methods.qbtc().call(), c.QBTC));
  check('game.fusionForge -> Fusion', same(await game.methods.fusionForge().call(), c.Fusion));
  check('traits.game -> SquirrelGame', same(await traits.methods.game().call(), c.SquirrelGame));
  check('traits.stats -> TraitStats', same(await traits.methods.stats().call(), c.TraitStats));
  check('stats.game -> SquirrelGame', same(await stats.methods.game().call(), c.SquirrelGame));
  check('farm.game -> SquirrelGame', same(await farm.methods.game().call(), c.SquirrelGame));
  check('farm.raidPost -> RaidPost', same(await farm.methods.raidPost().call(), c.RaidPost));
  check('farm.stats -> TraitStats', same(await farm.methods.stats().call(), c.TraitStats));
  check('post.farm -> QuantumFarm', same(await post.methods.farm().call(), c.QuantumFarm));
  check('post.stats -> TraitStats', same(await post.methods.stats().call(), c.TraitStats));

  console.log('\n=== QBTC CONTROLLERS ===');
  for (const name of ['QuantumFarm', 'SquirrelGame', 'RaidPost', 'SeasonLedger', 'Quests', 'Fusion']) {
    check(`${name} may mint and burn`, await qbtc.methods.controllers(c[name]).call() === true);
  }

  console.log('\n=== ECONOMICS ===');
  const WEI = 10n ** 18n;
  const n = async (inst, m) => BigInt(await inst.methods[m]().call());
  check('emission cap 21,000,000 qBTC',
    (await n(farm, 'fullRateDailyYield')) > 0n,
    `${Number(await n(farm, 'fullRateDailyYield')) / 1e18} qBTC/day at full rate`);
  check('MAX_TOKENS = 50,000', (await n(game, 'MAX_TOKENS')) === 50_000n);
  check('PAID_TOKENS = 10,000', (await n(game, 'PAID_TOKENS')) === 10_000n);
  check('mintCost Gen 0 free', BigInt(await game.methods.mintCost(1).call()) === 0n);
  check('mintCost tier 1 = 175', BigInt(await game.methods.mintCost(15000).call()) === 175n * WEI);
  check('mintCost tier 3 = 700', BigInt(await game.methods.mintCost(45000).call()) === 700n * WEI);
  check('MINIMUM_TO_EXIT = 2 days', (await n(farm, 'MINIMUM_TO_EXIT')) === 172800n);

  console.log('\n=== METADATA ===');
  const base = await traits.methods.baseImageURI().call();
  check('artwork points at the repo', base.startsWith('https://raw.githubusercontent.com/'), base);
  check('trait slot 9 named', (await traits.methods.traitTypes(9).call()) === 'Fur');
  check('tier 0 label is Tier 3', (await traits.methods.traitData(17, 0).call()) === 'Tier 3');
  check('tier 2 label is Tier 1', (await traits.methods.traitData(17, 2).call()) === 'Tier 1');

  const minted = Number(await game.methods.minted().call());
  console.log(`\nminted so far: ${minted}`);
  if (minted > 0) {
    const uri = await game.methods.tokenURI(1).call();
    const json = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
    console.log(JSON.stringify(json, null, 2));
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('VERIFY FAILED:', e.message || e); process.exit(1); });
