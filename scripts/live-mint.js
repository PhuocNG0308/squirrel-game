/**
 * End-to-end mint against the live network: commit, wait for the reveal block
 * to be mined, reveal, then read back the resulting token's metadata.
 *
 * Costs one Gen 0 mint (0.069420 QRL) per token. Pass an amount (1-10).
 */
const fs = require('fs');
const path = require('path');
const { connect, loadDeployment, sendRaw } = require('./qrl');

const MINT_PRICE = 69420000000000000n;

function abiOf(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'abi', `${name}.json`), 'utf8'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const amount = Number(process.argv[2] || 1);
  const { web3, account } = connect();
  const d = loadDeployment();

  const game = new web3.qrl.Contract(abiOf('SquirrelGame'), d.contracts.SquirrelGame);
  const stats = new web3.qrl.Contract(abiOf('TraitStats'), d.contracts.TraitStats);

  const before = Number(await game.methods.minted().call());
  console.log(`minted before: ${before}`);
  console.log(`committing ${amount} mint(s) for ${Number(MINT_PRICE * BigInt(amount)) / 1e18} QRL...`);

  const commit = await sendRaw(web3, account, {
    to: d.contracts.SquirrelGame,
    data: game.methods.commitMint(amount, false).encodeABI(),
    value: MINT_PRICE * BigInt(amount),
    gas: 600000,
  });
  console.log(`  committed in block ${commit.blockNumber}  tx ${commit.transactionHash}`);

  // The seed comes from the block after the commit, so it must be mined and
  // then hashable — poll until the contract says the reveal is available.
  process.stdout.write('  waiting for reveal block');
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(15000);
    ready = await game.methods.canReveal(account.address).call();
    process.stdout.write(ready ? ' ready\n' : '.');
  }
  if (!ready) throw new Error('reveal did not become available');

  console.log('revealing...');
  const reveal = await sendRaw(web3, account, {
    to: d.contracts.SquirrelGame,
    data: game.methods.revealMint(account.address).encodeABI(),
    gas: 3000000,
  });
  console.log(`  revealed in block ${reveal.blockNumber}  tx ${reveal.transactionHash}`);

  const after = Number(await game.methods.minted().call());
  console.log(`minted after: ${after}\n`);

  for (let id = before + 1; id <= after; id++) {
    const t = await game.methods.tokenTraits(id).call();
    const sheet = await stats.methods.statsOf(id).call();
    const owner = await game.methods.ownerOf(id).call();
    const uri = await game.methods.tokenURI(id).call();
    const json = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));

    const kind = t.isQuantum ? 'Quantum Computer' : `Squirrel Tier ${3 - Number(t.tierIndex)}`;
    console.log(`#${id}  ${kind}`);
    console.log(`     owner : ${owner}${owner === account.address ? '' : '   <-- STOLEN'}`);
    console.log(`     image : ${json.image.split('/').pop()}`);
    const sheetLine = sheet.labels
      .map((l, i) => `${l} ${Number(sheet.mods[i]) / 100}%`)
      .join('  ');
    console.log(`     stats : ${sheetLine}`);
    console.log(`     traits: ${json.attributes
      .filter((a) => !sheet.labels.includes(a.trait_type))
      .map((a) => `${a.trait_type}=${a.value}`).join(', ')}`);
  }
}

main().catch((e) => { console.error('LIVE MINT FAILED:', e.message || e); process.exit(1); });
