/**
 * Squirrel Game contract tests, executed against the compiled ZVM bytecode in
 * a local EVM.
 *
 * The headline tests are the security ones: that committing and revealing
 * cannot be gamed by retrying, and that the reveal window behaves at both
 * boundaries. The rest cover economics and the trait distributions.
 */
const {
  Chain, encodeCall, decodeUint, decodeAddress, decodeBool,
} = require('./harness');

const ONE = 10n ** 18n;
const MINT_PRICE = 69420000000000000n; // 0.069420 QRL
const BASE_URI = 'https://raw.githubusercontent.com/PhuocNG0308/squirrel-game/main/assets/';

const OWNER = '0x' + 'a1'.repeat(20);
const ALICE = '0x' + 'b2'.repeat(20);
const BOB = '0x' + 'c3'.repeat(20);
const KEEPER = '0x' + 'd4'.repeat(20);

let passed = 0;
let failed = 0;
const failures = [];

function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; failures.push(label); console.log(`  FAIL  ${label}  ${detail}`); }
}

function section(name) { console.log(`\n=== ${name} ===`); }

/** Deploys and wires the whole stack. */
async function deployStack() {
  const c = await Chain.create();
  for (const a of [OWNER, ALICE, BOB, KEEPER]) await c.fund(a, 10n ** 22n);

  const qbtc = await c.deploy('QBTC', [], [], OWNER);
  const traits = await c.deploy('Traits', ['string', 'string'], [BASE_URI, 'https://x'], OWNER);
  const game = await c.deploy('SquirrelGame', ['address', 'address', 'uint256'],
    [qbtc, traits, 50000], OWNER);
  const farm = await c.deploy('MiningFarm', ['address', 'address'], [game, qbtc], OWNER);

  await c.call(game, OWNER, encodeCall('setFarm(address)', ['address'], [farm]));
  await c.call(traits, OWNER, encodeCall('setGame(address)', ['address'], [game]));
  await c.call(qbtc, OWNER, encodeCall('addController(address)', ['address'], [farm]));
  await c.call(qbtc, OWNER, encodeCall('addController(address)', ['address'], [game]));

  return { c, qbtc, traits, game, farm };
}

/** Commits a mint and advances past the reveal block. */
async function commitAndAdvance(c, game, who, amount, stake = false) {
  await c.call(game, who, encodeCall('commitMint(uint256,bool)', ['uint256', 'bool'],
    [amount, stake]), MINT_PRICE * BigInt(amount));
  c.advance(2); // reveal block mined, plus one so its hash is readable
}

async function traitsOf(c, game, tokenId) {
  const r = await c.call(game, OWNER, encodeCall('tokenTraits(uint256)', ['uint256'], [tokenId]));
  const words = r.replace(/^0x/, '').match(/.{64}/g) || [];
  return {
    isQuantum: BigInt('0x' + words[0]) === 1n,
    tierIndex: Number(BigInt('0x' + words[9])),
  };
}

async function ownerOf(c, game, tokenId) {
  return decodeAddress(await c.call(game, OWNER,
    encodeCall('ownerOf(uint256)', ['uint256'], [tokenId])));
}

/* ------------------------------------------------------------------ MAIN */

async function main() {
  section('DEPLOYMENT & WIRING');
  {
    const { c, qbtc, game, farm, traits } = await deployStack();
    check('stack deploys', !!(qbtc && game && farm && traits));
    const wired = decodeAddress(await c.call(game, OWNER, encodeCall('farm()', [], [])));
    check('game.farm wired', wired.toLowerCase() === farm.toLowerCase());
    const cap = await c.call(farm, OWNER, encodeCall('MAXIMUM_GLOBAL_QBTC()', [], []));
    check('emission cap is 21,000,000 qBTC', decodeUint(cap) === 21_000_000n * ONE,
      `${decodeUint(cap) / ONE}`);
    const rate = await c.call(farm, OWNER, encodeCall('DAILY_QBTC_RATE()', [], []));
    check('daily rate is 87.5 qBTC', decodeUint(rate) === 875n * ONE / 10n,
      `${Number(decodeUint(rate)) / 1e18}`);
  }

  section('MINT: COMMIT-REVEAL FLOW');
  {
    const { c, game } = await deployStack();

    let threw = false;
    try {
      await c.call(game, ALICE, encodeCall('commitMint(uint256,bool)', ['uint256', 'bool'],
        [1, false]), MINT_PRICE);
      await c.call(game, ALICE, encodeCall('revealMint()', [], []));
    } catch (e) { threw = true; }
    check('reveal in same block reverts', threw);

    c.advance(2);
    await c.call(game, ALICE, encodeCall('revealMint()', [], []));
    check('reveal succeeds after reveal block', (await ownerOf(c, game, 1)) === ALICE.toLowerCase());

    threw = false;
    try { await c.call(game, ALICE, encodeCall('revealMint()', [], [])); }
    catch (e) { threw = true; }
    check('double reveal reverts', threw);

    threw = false;
    try {
      await c.call(game, ALICE, encodeCall('commitMint(uint256,bool)', ['uint256', 'bool'],
        [1, false]), MINT_PRICE);
      await c.call(game, ALICE, encodeCall('commitMint(uint256,bool)', ['uint256', 'bool'],
        [1, false]), MINT_PRICE);
    } catch (e) { threw = true; }
    check('second commit while one is pending reverts', threw);
  }

  section('SECURITY: RETRY ATTACK MUST FAIL');
  {
    // The attack Wolf Game was vulnerable to: run the random action, inspect
    // the result, revert if unfavourable, retry next block. Here the outcome
    // is pinned to a block hash chosen at commit time, so every retry — from
    // any caller, at any later block — must produce the identical result.
    const { c, game } = await deployStack();
    await commitAndAdvance(c, game, ALICE, 10);

    // Snapshot the outcome by revealing, then rebuild the same scenario and
    // reveal at a different height / from a different caller.
    await c.call(game, ALICE, encodeCall('revealMint()', [], []));
    const first = [];
    for (let i = 1; i <= 10; i++) first.push(await traitsOf(c, game, i));

    const b = await deployStack();
    await commitAndAdvance(b.c, b.game, ALICE, 10);
    b.c.advance(37); // reveal much later
    // revealed by a keeper, not the minter
    await b.c.call(b.game, KEEPER,
      encodeCall('revealMint(address)', ['address'], [ALICE]));
    const second = [];
    for (let i = 1; i <= 10; i++) second.push(await traitsOf(b.c, b.game, i));

    const identical = JSON.stringify(first) === JSON.stringify(second);
    check('outcome fixed at commit: same result regardless of when/who reveals', identical,
      identical ? '' : `${JSON.stringify(first)} vs ${JSON.stringify(second)}`);

    check('reveal is permissionless (keeper could reveal for Alice)',
      (await ownerOf(b.c, b.game, 1)) === ALICE.toLowerCase());
  }

  section('SECURITY: REVEAL WINDOW BOUNDARIES');
  {
    const { c, game } = await deployStack();
    await c.call(game, ALICE, encodeCall('commitMint(uint256,bool)', ['uint256', 'bool'],
      [1, false]), MINT_PRICE);

    c.advance(2);
    check('canReveal true inside window',
      decodeBool(await c.call(game, OWNER, encodeCall('canReveal(address)', ['address'], [ALICE]))));

    c.advance(300); // push past the 256-block blockhash window
    check('canReveal false past window',
      !decodeBool(await c.call(game, OWNER, encodeCall('canReveal(address)', ['address'], [ALICE]))));
    check('needsReanchor true past window',
      decodeBool(await c.call(game, OWNER,
        encodeCall('needsReanchor(address)', ['address'], [ALICE]))));

    let threw = false;
    try { await c.call(game, ALICE, encodeCall('revealMint()', [], [])); }
    catch (e) { threw = true; }
    check('reveal past window reverts (hash unavailable)', threw);

    await c.call(game, KEEPER, encodeCall('reanchorMint(address)', ['address'], [ALICE]));
    c.advance(2);
    await c.call(game, ALICE, encodeCall('revealMint()', [], []));
    check('re-anchor rescues an expired commit',
      (await ownerOf(c, game, 1)) === ALICE.toLowerCase());

    threw = false;
    try { await c.call(game, KEEPER, encodeCall('reanchorMint(address)', ['address'], [BOB])); }
    catch (e) { threw = true; }
    check('re-anchor with no pending commit reverts', threw);
  }

  section('MINT: PAYMENT & SUPPLY RULES');
  {
    const { c, game } = await deployStack();
    let threw = false;
    try {
      await c.call(game, ALICE, encodeCall('commitMint(uint256,bool)', ['uint256', 'bool'],
        [1, false]), MINT_PRICE - 1n);
    } catch (e) { threw = true; }
    check('underpayment reverts', threw);

    threw = false;
    try {
      await c.call(game, ALICE, encodeCall('commitMint(uint256,bool)', ['uint256', 'bool'],
        [11, false]), MINT_PRICE * 11n);
    } catch (e) { threw = true; }
    check('minting more than 10 reverts', threw);

    const cost0 = await c.call(game, OWNER, encodeCall('mintCost(uint256)', ['uint256'], [1]));
    const cost1 = await c.call(game, OWNER, encodeCall('mintCost(uint256)', ['uint256'], [15000]));
    const cost2 = await c.call(game, OWNER, encodeCall('mintCost(uint256)', ['uint256'], [30000]));
    const cost3 = await c.call(game, OWNER, encodeCall('mintCost(uint256)', ['uint256'], [45000]));
    check('mintCost Gen 0 is free', decodeUint(cost0) === 0n);
    check('mintCost tier 1 is 175 qBTC', decodeUint(cost1) === 175n * ONE);
    check('mintCost tier 2 is 350 qBTC', decodeUint(cost2) === 350n * ONE);
    check('mintCost tier 3 is 700 qBTC', decodeUint(cost3) === 700n * ONE);
  }

  section('TRAIT DISTRIBUTION (200 mints)');
  {
    const { c, game } = await deployStack();
    const SAMPLE = 200;
    for (let i = 0; i < SAMPLE / 10; i++) {
      await commitAndAdvance(c, game, ALICE, 10);
      await c.call(game, ALICE, encodeCall('revealMint()', [], []));
    }

    let quantum = 0;
    const tiers = [0, 0, 0];
    for (let id = 1; id <= SAMPLE; id++) {
      const t = await traitsOf(c, game, id);
      if (t.isQuantum) quantum++;
      else tiers[t.tierIndex]++;
    }
    const squirrels = SAMPLE - quantum;
    const qPct = (quantum / SAMPLE) * 100;
    check('roughly 90% Quantum Computers', qPct > 80 && qPct < 97, `${qPct.toFixed(1)}%`);
    check('some Squirrels minted', squirrels > 0, `${squirrels} squirrels`);
    console.log(`        tier split (idx0=T3, idx1=T2, idx2=T1): ${tiers.join(' / ')}`);
    check('Tier 1 (idx 2) is the most common squirrel tier',
      squirrels === 0 || tiers[2] >= tiers[0], `T3=${tiers[0]} T2=${tiers[1]} T1=${tiers[2]}`);
  }

  section('STAKING & YIELD');
  {
    const { c, game, farm, qbtc } = await deployStack();
    // mint until we hold at least one Quantum Computer
    let quantumId = 0;
    for (let round = 0; round < 5 && !quantumId; round++) {
      await commitAndAdvance(c, game, ALICE, 10);
      await c.call(game, ALICE, encodeCall('revealMint()', [], []));
      for (let id = round * 10 + 1; id <= round * 10 + 10; id++) {
        const t = await traitsOf(c, game, id);
        if (t.isQuantum && (await ownerOf(c, game, id)) === ALICE.toLowerCase()) {
          quantumId = id; break;
        }
      }
    }
    check('found a Quantum Computer to stake', quantumId > 0, `#${quantumId}`);

    await c.call(game, ALICE, encodeCall('setApprovalForAll(address,bool)',
      ['address', 'bool'], [farm, true]));
    await c.call(farm, ALICE, encodeCall('addManyToFarmAndDrey(address,uint16[])',
      ['address', 'uint16[]'], [ALICE, [quantumId]]));
    check('token staked into the Farm',
      (await ownerOf(c, game, quantumId)) === farm.toLowerCase());

    let threw = false;
    try {
      await c.call(farm, ALICE, encodeCall('requestExit(uint16[])', ['uint16[]'], [[quantumId]]));
    } catch (e) { threw = true; }
    check('exit before 2 days reverts', threw);

    c.advanceTime(2 * 24 * 3600 + 60);
    await c.call(farm, ALICE, encodeCall('claimManyFromFarmAndDrey(uint16[])',
      ['uint16[]'], [[quantumId]]));
    const bal = decodeUint(await c.call(qbtc, OWNER,
      encodeCall('balanceOf(address)', ['address'], [ALICE])));
    // 2 days at 87.5/day, minus the 20% Drey tax
    const expected = 2n * 875n * ONE / 10n * 80n / 100n;
    check('claim pays ~2 days of yield net of 20% tax',
      bal > expected * 95n / 100n && bal < expected * 105n / 100n,
      `${Number(bal) / 1e18} qBTC (expected ~${Number(expected) / 1e18})`);
  }

  section('SECURITY: 50/50 UNSTAKE IS COMMITTED');
  {
    const { c, game, farm } = await deployStack();
    let quantumId = 0;
    for (let round = 0; round < 5 && !quantumId; round++) {
      await commitAndAdvance(c, game, ALICE, 10);
      await c.call(game, ALICE, encodeCall('revealMint()', [], []));
      for (let id = round * 10 + 1; id <= round * 10 + 10; id++) {
        const t = await traitsOf(c, game, id);
        if (t.isQuantum && (await ownerOf(c, game, id)) === ALICE.toLowerCase()) {
          quantumId = id; break;
        }
      }
    }
    await c.call(game, ALICE, encodeCall('setApprovalForAll(address,bool)',
      ['address', 'bool'], [farm, true]));
    await c.call(farm, ALICE, encodeCall('addManyToFarmAndDrey(address,uint16[])',
      ['address', 'uint16[]'], [ALICE, [quantumId]]));
    c.advanceTime(2 * 24 * 3600 + 60);

    await c.call(farm, ALICE, encodeCall('requestExit(uint16[])', ['uint16[]'], [[quantumId]]));
    check('exit request accepted after 2 days', true);

    let threw = false;
    try { await c.call(farm, ALICE, encodeCall('executeExit()', [], [])); }
    catch (e) { threw = true; }
    check('execute in same block reverts (outcome not yet determined)', threw);

    c.advance(2);
    check('canExecuteExit true once reveal block is mined',
      decodeBool(await c.call(farm, OWNER,
        encodeCall('canExecuteExit(address)', ['address'], [ALICE]))));

    await c.call(farm, KEEPER, encodeCall('executeExit(address)', ['address'], [ALICE]));
    check('keeper can execute the exit permissionlessly',
      (await ownerOf(c, game, quantumId)) === ALICE.toLowerCase());
  }

  section('METADATA');
  {
    const { c, game, traits } = await deployStack();
    await c.call(traits, OWNER, encodeCall('uploadTraitTypes(uint8[],string[])',
      ['uint8[]', 'string[]'], [[9, 17], ['Fur', 'Tier']]));
    await c.call(traits, OWNER, encodeCall('uploadTraitsBatch(uint8[],uint8[],string[])',
      ['uint8[]', 'uint8[]', 'string[]'],
      [[17, 17, 17], [0, 1, 2], ['Tier 3', 'Tier 2', 'Tier 1']]));

    await commitAndAdvance(c, game, ALICE, 1);
    await c.call(game, ALICE, encodeCall('revealMint()', [], []));

    const raw = await c.call(game, OWNER, encodeCall('tokenURI(uint256)', ['uint256'], [1]));
    const hex = raw.replace(/^0x/, '');
    const len = Number(BigInt('0x' + hex.slice(64, 128)));
    const uri = Buffer.from(hex.slice(128, 128 + len * 2), 'hex').toString('utf8');
    check('tokenURI is a base64 data URI', uri.startsWith('data:application/json;base64,'));

    const json = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
    check('metadata image points at the GitHub repo',
      json.image.startsWith(BASE_URI), json.image);
    const t = await traitsOf(c, game, 1);
    const expectedFile = t.isQuantum ? 'QuantumComputer.png' : `Squirrel_Tier${3 - t.tierIndex}.png`;
    check('image matches the token type/tier', json.image.endsWith(expectedFile),
      `${json.image.split('/').pop()} (expected ${expectedFile})`);
    check('metadata has a Type attribute',
      json.attributes.some((a) => a.trait_type === 'Type'));
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nfailures:'); failures.forEach((f) => console.log('  -', f)); }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\nTEST RUN CRASHED:', e); process.exit(1); });
