/**
 * Wires an already-deployed stack.
 *
 * Deployment and wiring are separate steps because deployment is slow — QRL's
 * 60-second blocks and the proxy's write rate limit put a full run near forty
 * minutes — so a failure in the wiring stage should not mean paying for every
 * contract again. Reads addresses from deployments/testnet.json.
 *
 * Every call is idempotent: setters overwrite and addController is a flag, so
 * re-running after a partial failure is safe.
 */
const fs = require('fs');
const path = require('path');
const { connect, artifact, sendRaw, loadDeployment, ROOT } = require('./qrl');

async function main() {
  if (!process.argv.includes('--confirm')) {
    console.error('Refusing to send transactions without --confirm.');
    process.exit(1);
  }

  const { web3, account } = connect();
  const d = loadDeployment();
  const c = d.contracts;
  const at = (name, addr) => new web3.qrl.Contract(artifact(name).abi, addr);

  const qbtc = at('QBTC', c.QBTC);
  const traits = at('Traits', c.Traits);
  const game = at('SquirrelGame', c.SquirrelGame);
  const farm = at('QuantumFarm', c.QuantumFarm);
  const post = at('RaidPost', c.RaidPost);

  console.log('deployer:', account.address);
  console.log('wiring', Object.keys(c).length, 'contracts\n');

  const wire = async (label, target, tx, gas = 220000) => {
    await sendRaw(web3, account, { to: target, data: tx.encodeABI(), gas });
    console.log('  ok  ' + label);
  };

  await wire('game.setFarm', c.SquirrelGame, game.methods.setFarm(c.QuantumFarm));
  await wire('game.setFusionForge', c.SquirrelGame, game.methods.setFusionForge(c.Fusion));
  await wire('traits.setGame', c.Traits, traits.methods.setGame(c.SquirrelGame));
  await wire('traits.setStats', c.Traits, traits.methods.setStats(c.TraitStats));
  await wire('farm.setRaidPost', c.QuantumFarm, farm.methods.setRaidPost(c.RaidPost));
  await wire('farm.setStats', c.QuantumFarm, farm.methods.setStats(c.TraitStats));
  await wire('post.setStats', c.RaidPost, post.methods.setStats(c.TraitStats));

  for (const name of ['QuantumFarm', 'SquirrelGame', 'RaidPost', 'SeasonLedger', 'Quests', 'Fusion']) {
    await wire(`qbtc.addController ${name}`, c.QBTC, qbtc.methods.addController(c[name]));
  }

  console.log('\nseeding trait metadata');
  const names = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'trait-names.json'), 'utf8'));
  await wire(`uploadTraitTypes (${names.length} slots)`, c.Traits,
    traits.methods.uploadTraitTypes(names.map((n) => n.slot), names.map((n) => n.trait)),
    2500000);

  const bTypes = [], bIndices = [], bValues = [];
  for (const n of names) {
    n.values.forEach((v, i) => { bTypes.push(n.slot); bIndices.push(i); bValues.push(v); });
  }
  await wire(`uploadTraitsBatch (${bValues.length} values)`, c.Traits,
    traits.methods.uploadTraitsBatch(bTypes, bIndices, bValues), 6000000);

  console.log('\nwiring complete');
}

main().catch((e) => { console.error('\nWIRING FAILED:', e.message || e); process.exit(1); });
