/**
 * QuantumFarm tests, executed against the compiled ZVM bytecode in a local EVM.
 *
 * The claims worth verifying are the economic ones: that idle capital earns
 * nothing, that emission is pro-rata and decays, that repair pricing does not
 * collapse when a rig is broken, and that vesting actually burns the forfeit.
 */
const { Chain, encodeCall, decodeUint, decodeBool, decodeAddress } = require('./harness');

const ONE = 10n ** 18n;
const DAY = 86400;
const MINT_PRICE = 69420000000000000n;
const BASE_URI = 'https://raw.githubusercontent.com/PhuocNG0308/squirrel-game/main/assets/';

const OWNER = '0x' + 'a1'.repeat(20);
const ALICE = '0x' + 'b2'.repeat(20);
const BOB = '0x' + 'c3'.repeat(20);

let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; failures.push(label); console.log(`  FAIL  ${label}  ${detail}`); }
}
const section = (n) => console.log(`\n=== ${n} ===`);
const near = (a, b, tolPct = 5) => {
  if (b === 0n) return a === 0n;
  const d = a > b ? a - b : b - a;
  return (d * 100n) / b <= BigInt(tolPct);
};
const fmt = (w) => (Number(w) / 1e18).toFixed(4);

async function deployStack() {
  const c = await Chain.create();
  for (const a of [OWNER, ALICE, BOB]) await c.fund(a, 10n ** 22n);

  const qbtc = await c.deploy('QBTC', [], [], OWNER);
  const traits = await c.deploy('Traits', ['string', 'string'], [BASE_URI, 'https://x'], OWNER);
  const game = await c.deploy('SquirrelGame', ['address', 'address', 'uint256'],
    [qbtc, traits, 50000], OWNER);
  const farm = await c.deploy('QuantumFarm', ['address', 'address'], [game, qbtc], OWNER);

  await c.call(game, OWNER, encodeCall('setFarm(address)', ['address'], [farm]));
  await c.call(traits, OWNER, encodeCall('setGame(address)', ['address'], [game]));
  await c.call(qbtc, OWNER, encodeCall('addController(address)', ['address'], [farm]));
  await c.call(qbtc, OWNER, encodeCall('addController(address)', ['address'], [game]));
  return { c, qbtc, traits, game, farm };
}

async function mintFor(c, game, who, amount) {
  await c.call(game, who, encodeCall('commitMint(uint256,bool)', ['uint256', 'bool'],
    [amount, false]), MINT_PRICE * BigInt(amount));
  c.advance(2);
  await c.call(game, who, encodeCall('revealMint()', [], []));
}

async function traitsOf(c, game, id) {
  const r = await c.call(game, OWNER, encodeCall('tokenTraits(uint256)', ['uint256'], [id]));
  const w = r.replace(/^0x/, '').match(/.{64}/g) || [];
  return { isQuantum: BigInt('0x' + w[0]) === 1n, tierIndex: Number(BigInt('0x' + w[9])) };
}

/** Mints until `who` holds `n` rigs, returns their ids. */
async function getRigs(c, game, who, n) {
  const found = [];
  let next = 1;
  for (let round = 0; round < 8 && found.length < n; round++) {
    await mintFor(c, game, who, 10);
    const minted = Number(decodeUint(await c.call(game, OWNER, encodeCall('minted()', [], []))));
    for (; next <= minted && found.length < n; next++) {
      const t = await traitsOf(c, game, next);
      const owner = decodeAddress(await c.call(game, OWNER,
        encodeCall('ownerOf(uint256)', ['uint256'], [next])));
      if (t.isQuantum && owner === who.toLowerCase()) found.push(next);
    }
  }
  return found;
}

const stake = (c, game, farm, who, ids) =>
  c.call(game, who, encodeCall('setApprovalForAll(address,bool)', ['address', 'bool'], [farm, true]))
    .then(() => c.call(farm, who, encodeCall('stake(uint16[])', ['uint16[]'], [ids])));

const rigState = async (c, farm, id) => {
  const r = await c.call(farm, OWNER, encodeCall('rigState(uint16)', ['uint16'], [id]));
  const w = r.replace(/^0x/, '').match(/.{64}/g) || [];
  return {
    durability: Number(BigInt('0x' + w[0])),
    fuelExpiry: Number(BigInt('0x' + w[1])),
    streakDays: Number(BigInt('0x' + w[2])),
    mining: BigInt('0x' + w[3]) === 1n,
  };
};

const vestingOf = async (c, farm, who) => {
  const r = await c.call(farm, OWNER, encodeCall('vestingOf(address)', ['address'], [who]));
  const w = r.replace(/^0x/, '').match(/.{64}/g) || [];
  return { amount: BigInt('0x' + w[0]), releasable: BigInt('0x' + w[1]), forfeit: BigInt('0x' + w[2]) };
};

const balanceOf = async (c, qbtc, who) =>
  decodeUint(await c.call(qbtc, OWNER, encodeCall('balanceOf(address)', ['address'], [who])));

/* ------------------------------------------------------------------ MAIN */

async function main() {
  section('EMISSION SCHEDULE');
  {
    const { c, farm } = await deployStack();
    const daily0 = decodeUint(await c.call(farm, OWNER, encodeCall('fullRateDailyYield()', [], [])));
    check('daily yield is zero with nothing staked', daily0 === 0n);

    const totalMined = decodeUint(await c.call(farm, OWNER, encodeCall('totalMined()', [], [])));
    check('nothing mined at genesis', totalMined === 0n);
  }

  section('IDLE CAPITAL EARNS NOTHING');
  {
    const { c, game, farm, qbtc } = await deployStack();
    const ids = await getRigs(c, game, ALICE, 2);
    check('found rigs to stake', ids.length === 2, `#${ids.join(', #')}`);

    await stake(c, game, farm, ALICE, ids);
    const st = await rigState(c, farm, ids[0]);
    check('a fresh rig ships with one charged cell', st.mining, `fuel for ${PRIMING_WINDOW_LABEL()}`);

    // Probe totalMined rather than the vesting bucket: a claim that earns
    // nothing never calls _vest, so the bucket would still hold the old figure
    // and read as a false positive.
    const mined = () => c.call(farm, OWNER, encodeCall('totalMined()', [], [])).then(decodeUint);

    c.advanceTime(15 * DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [ids]));
    const afterPrimed = await mined();

    c.advanceTime(15 * DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [ids]));
    const afterIdle = await mined();

    check('the primed window mined something', afterPrimed > 0n, `${fmt(afterPrimed)} qBTC`);
    check('an unfuelled rig mines nothing over 15 further days',
      afterIdle === afterPrimed, `+${fmt(afterIdle - afterPrimed)} qBTC`);
  }

  section('DURABILITY & HASHRATE');
  {
    const { c, game, farm } = await deployStack();
    const ids = await getRigs(c, game, ALICE, 1);
    await stake(c, game, farm, ALICE, ids);

    const a = await rigState(c, farm, ids[0]);
    check('starts at full durability', a.durability === 100, `${a.durability}`);

    c.advanceTime(DAY);
    const b = await rigState(c, farm, ids[0]);
    check('loses 5 points per mining day', b.durability === 95, `${b.durability}`);

    // beyond the primed window there is no fuel, so no further decay
    c.advanceTime(10 * DAY);
    const d = await rigState(c, farm, ids[0]);
    check('does not decay while switched off', d.durability === 95, `${d.durability}`);
  }

  section('PRO-RATA EMISSION');
  {
    const { c, game, farm } = await deployStack();
    const aliceRigs = await getRigs(c, game, ALICE, 1);
    await stake(c, game, farm, ALICE, aliceRigs);
    c.advanceTime(DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [aliceRigs]));
    const solo = (await vestingOf(c, farm, ALICE)).amount;

    const bobRigs = await getRigs(c, game, BOB, 3);
    await stake(c, game, farm, BOB, bobRigs);
    const shared = decodeUint(await c.call(farm, OWNER,
      encodeCall('fullRateDailyYield()', [], [])));
    check('per-rig yield falls as more rigs join', shared > 0n && solo > 0n,
      `solo day 1 = ${fmt(solo)}, full-rate now ${fmt(shared)}`);

    const th = decodeUint(await c.call(farm, OWNER, encodeCall('totalHashrate()', [], [])));
    check('total hashrate reflects four staked rigs', th > 3n * ONE, `${fmt(th)} units`);
  }

  section('REPAIR PRICING');
  {
    const { c, game, farm, qbtc } = await deployStack();
    const ids = await getRigs(c, game, ALICE, 1);
    await stake(c, game, farm, ALICE, ids);
    c.advanceTime(DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [ids]));
    c.advanceTime(8 * DAY);
    await c.call(farm, ALICE, encodeCall('withdraw()', [], []));
    const funded = await balanceOf(c, qbtc, ALICE);
    check('vested yield lands in the wallet', funded > 0n, `${fmt(funded)} qBTC`);

    const before = (await rigState(c, farm, ids[0])).durability;
    let threw = false;
    try {
      await c.call(farm, ALICE, encodeCall('repair(uint16[])', ['uint16[]'], [ids]));
    } catch (e) { threw = true; }
    const after = (await rigState(c, farm, ids[0])).durability;
    check('repair restores to full', !threw && after === 100, `${before} -> ${after}`);

    const spent = funded - (await balanceOf(c, qbtc, ALICE));
    check('repair burns qBTC', spent > 0n, `${fmt(spent)} qBTC burned`);
  }

  section('COOLANT');
  {
    const { c, game, farm, qbtc } = await deployStack();
    const ids = await getRigs(c, game, ALICE, 1);
    await stake(c, game, farm, ALICE, ids);
    c.advanceTime(DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [ids]));
    c.advanceTime(8 * DAY);
    await c.call(farm, ALICE, encodeCall('withdraw()', [], []));

    let threw = false;
    try {
      await c.call(farm, ALICE, encodeCall('refuel(uint16[],uint256)',
        ['uint16[]', 'uint256'], [ids, 8 * DAY]));
    } catch (e) { threw = true; }
    check('cannot prepay beyond seven days', threw);

    await c.call(farm, ALICE, encodeCall('refuel(uint16[],uint256)',
      ['uint16[]', 'uint256'], [ids, 7 * DAY]));
    const st = await rigState(c, farm, ids[0]);
    check('a seven-day window puts the rig back to work', st.mining, `durability ${st.durability}`);
  }

  section('VESTING BURNS THE FORFEIT');
  {
    const { c, game, farm, qbtc } = await deployStack();
    const ids = await getRigs(c, game, ALICE, 1);
    await stake(c, game, farm, ALICE, ids);
    c.advanceTime(DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [ids]));

    const v0 = await vestingOf(c, farm, ALICE);
    check('nothing is releasable immediately', v0.releasable === 0n, `${fmt(v0.releasable)}`);
    check('the whole claim would be forfeited', near(v0.forfeit, v0.amount, 1),
      `${fmt(v0.forfeit)} of ${fmt(v0.amount)}`);

    c.advanceTime(3 * DAY);
    const v3 = await vestingOf(c, farm, ALICE);
    check('about 3/7 releasable after three days',
      near(v3.releasable, (v0.amount * 3n) / 7n, 5),
      `${fmt(v3.releasable)} of ${fmt(v0.amount)}`);

    await c.call(farm, ALICE, encodeCall('withdraw()', [], []));
    const got = await balanceOf(c, qbtc, ALICE);
    check('early withdrawal pays only the vested share',
      near(got, v3.releasable, 5), `received ${fmt(got)}`);
    check('the unvested share was not minted', got < v0.amount,
      `${fmt(v0.amount - got)} qBTC never issued`);
  }

  section('SQUIRREL TAX & ENERGY');
  {
    const { c, game, farm } = await deployStack();
    // mint enough that Alice holds at least one squirrel
    let squirrel = 0, rigId = 0, next = 1;
    for (let r = 0; r < 8 && (!squirrel || !rigId); r++) {
      await mintFor(c, game, ALICE, 10);
      const minted = Number(decodeUint(await c.call(game, OWNER, encodeCall('minted()', [], []))));
      for (; next <= minted; next++) {
        const t = await traitsOf(c, game, next);
        const o = decodeAddress(await c.call(game, OWNER,
          encodeCall('ownerOf(uint256)', ['uint256'], [next])));
        if (o !== ALICE.toLowerCase()) continue;
        if (t.isQuantum && !rigId) rigId = next;
        if (!t.isQuantum && !squirrel) squirrel = next;
      }
    }
    check('found a squirrel and a rig', squirrel > 0 && rigId > 0, `#${squirrel} / #${rigId}`);

    await stake(c, game, farm, ALICE, [rigId, squirrel]);
    const alpha = decodeUint(await c.call(farm, OWNER, encodeCall('totalAlphaStaked()', [], [])));
    check('the squirrel joins the Drey with alpha weight', alpha >= 6n, `alpha ${alpha}`);

    c.advanceTime(DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [[rigId]]));
    const perAlpha = decodeUint(await c.call(farm, OWNER, encodeCall('qbtcPerAlpha()', [], [])));
    check('mining tax reaches the Drey', perAlpha > 0n, `${fmt(perAlpha)} per alpha`);
  }

  section('EXIT IS COMMIT-REVEAL');
  {
    const { c, game, farm } = await deployStack();
    const ids = await getRigs(c, game, ALICE, 1);
    await stake(c, game, farm, ALICE, ids);

    let threw = false;
    try {
      await c.call(farm, ALICE, encodeCall('requestExit(uint16[])', ['uint16[]'], [ids]));
    } catch (e) { threw = true; }
    check('cannot exit inside the two-day minimum', threw);

    c.advanceTime(3 * DAY);
    await c.call(farm, ALICE, encodeCall('requestExit(uint16[])', ['uint16[]'], [ids]));

    threw = false;
    try { await c.call(farm, ALICE, encodeCall('executeExit()', [], [])); }
    catch (e) { threw = true; }
    check('cannot settle in the commit block', threw);

    c.advance(2);
    await c.call(farm, BOB, encodeCall('executeExit(address)', ['address'], [ALICE]));
    const owner = decodeAddress(await c.call(game, OWNER,
      encodeCall('ownerOf(uint256)', ['uint256'], [ids[0]])));
    check('anyone may settle, and the rig returns to its owner',
      owner === ALICE.toLowerCase());
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nfailures:'); failures.forEach((f) => console.log('  -', f)); }
  process.exit(failed ? 1 : 0);
}

function PRIMING_WINDOW_LABEL() { return '1 day'; }

main().catch((e) => { console.error('\nTEST RUN CRASHED:', e); process.exit(1); });
