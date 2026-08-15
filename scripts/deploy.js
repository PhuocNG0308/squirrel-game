/**
 * Deploys the full Squirrel Game stack to QRL Zond testnet v2 (Hyperion)
 * and wires the four contracts together.
 *
 * Order matters: QBTC and Traits have no dependencies, SquirrelGame needs
 * both, and MiningFarm needs SquirrelGame. Cross-references that can only be
 * set after the fact (game -> farm, traits -> game) are patched in step 5.
 */
const fs = require('fs');
const path = require('path');
const { connect, deploy, send, saveDeployment, ROOT } = require('./qrl');

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
    console.error('Review the plan first:  npm run economics');
    console.error('Then deploy with:       npm run deploy -- --confirm');
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

  console.log('[1/6] deploying QBTC...');
  const qbtc = await deploy(web3, account, 'QBTC', [], 2500000);
  console.log('      QBTC          ', qbtc.options.address);

  console.log('[2/6] deploying Traits...');
  const traits = await deploy(web3, account, 'Traits', [BASE_IMAGE_URI, EXTERNAL_URI], 5000000);
  console.log('      Traits        ', traits.options.address);

  console.log('[3/6] deploying SquirrelGame...');
  const game = await deploy(
    web3, account, 'SquirrelGame',
    [qbtc.options.address, traits.options.address, MAX_TOKENS],
    13000000,
  );
  console.log('      SquirrelGame  ', game.options.address);

  console.log('[4/6] deploying MiningFarm...');
  const farm = await deploy(
    web3, account, 'MiningFarm',
    [game.options.address, qbtc.options.address],
    6000000,
  );
  console.log('      MiningFarm    ', farm.options.address);

  console.log('[5/6] wiring contracts...');
  await send(game.methods.setFarm(farm.options.address), account.address, 120000);
  console.log('      game.setFarm            ok');
  await send(traits.methods.setGame(game.options.address), account.address, 120000);
  console.log('      traits.setGame          ok');
  await send(qbtc.methods.addController(farm.options.address), account.address, 120000);
  console.log('      qbtc.addController farm ok');
  await send(qbtc.methods.addController(game.options.address), account.address, 120000);
  console.log('      qbtc.addController game ok');

  console.log('[6/6] seeding trait metadata...');
  const names = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'trait-names.json'), 'utf8'));

  const types = names.map((n) => n.slot);
  const typeNames = names.map((n) => n.trait);
  await send(traits.methods.uploadTraitTypes(types, typeNames), account.address, 2500000);
  console.log(`      uploadTraitTypes (${types.length} slots) ok`);

  const bTypes = [];
  const bIndices = [];
  const bValues = [];
  for (const n of names) {
    n.values.forEach((v, i) => { bTypes.push(n.slot); bIndices.push(i); bValues.push(v); });
  }
  await send(
    traits.methods.uploadTraitsBatch(bTypes, bIndices, bValues),
    account.address,
    6000000,
  );
  console.log(`      uploadTraitsBatch (${bValues.length} values) ok`);

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
      MiningFarm: farm.options.address,
    },
  };
  saveDeployment(deployment);

  console.log('\n=== DEPLOYED ===');
  console.table(deployment.contracts);
  console.log('saved -> deployments/testnet.json');
}

main().catch((e) => { console.error('\nDEPLOY FAILED:', e.message || e); process.exit(1); });
