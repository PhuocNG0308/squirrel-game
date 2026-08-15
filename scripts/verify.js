/**
 * Post-deployment verification: reads back on-chain state and confirms the
 * stack is wired correctly. Read-only — sends no transactions.
 *
 * Run after `npm run deploy -- --confirm`.
 */
const { connect, loadDeployment } = require('./qrl');
const fs = require('fs');
const path = require('path');

const ok = (b) => (b ? 'PASS' : 'FAIL');
let failures = 0;
function check(label, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${ok(cond)}  ${label.padEnd(44)} ${detail}`);
}

function abiOf(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'abi', `${name}.json`), 'utf8'));
}

async function main() {
  const { web3 } = connect();
  const d = loadDeployment();

  console.log(`network : ${d.network}`);
  console.log(`deployed: ${d.deployedAt}\n`);

  const game = new web3.qrl.Contract(abiOf('SquirrelGame'), d.contracts.SquirrelGame);
  const farm = new web3.qrl.Contract(abiOf('MiningFarm'), d.contracts.MiningFarm);
  const qbtc = new web3.qrl.Contract(abiOf('QBTC'), d.contracts.QBTC);
  const traits = new web3.qrl.Contract(abiOf('Traits'), d.contracts.Traits);

  console.log('=== CODE PRESENT ===');
  for (const [name, addr] of Object.entries(d.contracts)) {
    const code = await web3.qrl.getCode(addr);
    check(`${name} has runtime code`, code && code.length > 4, `${(code.length - 2) / 2} bytes  ${addr}`);
  }

  console.log('\n=== WIRING ===');
  const lower = (s) => String(s).toLowerCase();
  check('game.farm -> MiningFarm',
    lower(await game.methods.farm().call()) === lower(d.contracts.MiningFarm));
  check('game.traits -> Traits',
    lower(await game.methods.traits().call()) === lower(d.contracts.Traits));
  check('game.qbtc -> QBTC',
    lower(await game.methods.qbtc().call()) === lower(d.contracts.QBTC));
  check('traits.game -> SquirrelGame',
    lower(await traits.methods.game().call()) === lower(d.contracts.SquirrelGame));
  check('farm.game -> SquirrelGame',
    lower(await farm.methods.game().call()) === lower(d.contracts.SquirrelGame));
  check('qbtc controller: MiningFarm',
    await qbtc.methods.controllers(d.contracts.MiningFarm).call() === true);
  check('qbtc controller: SquirrelGame',
    await qbtc.methods.controllers(d.contracts.SquirrelGame).call() === true);

  console.log('\n=== ECONOMICS ON-CHAIN ===');
  const WEI = 10n ** 18n;
  const rate = BigInt(await farm.methods.DAILY_QBTC_RATE().call());
  const cap = BigInt(await farm.methods.MAXIMUM_GLOBAL_QBTC().call());
  const tax = BigInt(await farm.methods.QBTC_CLAIM_TAX_PERCENTAGE().call());
  const maxTokens = BigInt(await game.methods.MAX_TOKENS().call());
  const paid = BigInt(await game.methods.PAID_TOKENS().call());

  check('DAILY_QBTC_RATE = 87.5 qBTC', rate === 875n * WEI / 10n, `${Number(rate) / 1e18}`);
  check('MAXIMUM_GLOBAL_QBTC = 21,000,000', cap === 21_000_000n * WEI, `${Number(cap) / 1e18}`);
  check('claim tax = 20%', tax === 20n, `${tax}%`);
  check('MAX_TOKENS = 50,000', maxTokens === 50_000n, `${maxTokens}`);
  check('PAID_TOKENS = 10,000', paid === 10_000n, `${paid}`);

  const costs = [
    [BigInt(await game.methods.mintCost(1).call()), 0n, 'Gen 0 free'],
    [BigInt(await game.methods.mintCost(15000).call()), 175n * WEI, 'tier 1 = 175'],
    [BigInt(await game.methods.mintCost(30000).call()), 350n * WEI, 'tier 2 = 350'],
    [BigInt(await game.methods.mintCost(45000).call()), 700n * WEI, 'tier 3 = 700'],
  ];
  for (const [got, want, label] of costs) {
    check(`mintCost ${label}`, got === want, `${Number(got) / 1e18} qBTC`);
  }

  console.log('\n=== METADATA ===');
  const base = await traits.methods.baseImageURI().call();
  check('baseImageURI set', base.startsWith('https://raw.githubusercontent.com/'), base);
  check('trait type 9 named', (await traits.methods.traitTypes(9).call()).length > 0,
    await traits.methods.traitTypes(9).call());
  check('tier 0 label seeded', (await traits.methods.traitData(17, 0).call()) === 'Tier 3',
    await traits.methods.traitData(17, 0).call());
  check('tier 2 label seeded', (await traits.methods.traitData(17, 2).call()) === 'Tier 1',
    await traits.methods.traitData(17, 2).call());

  const minted = Number(await game.methods.minted().call());
  console.log(`\nminted so far: ${minted}`);
  if (minted > 0) {
    const uri = await game.methods.tokenURI(1).call();
    const json = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
    console.log('token #1 metadata:');
    console.log(JSON.stringify(json, null, 2));
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('VERIFY FAILED:', e.message || e); process.exit(1); });
