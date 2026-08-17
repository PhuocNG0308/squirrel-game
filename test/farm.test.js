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

const creditOf = async (c, farm, who) =>
  decodeUint(await c.call(farm, OWNER, encodeCall('credit(address)', ['address'], [who])));

const readU = async (c, to, sig, types = [], vals = []) =>
  decodeUint(await c.call(to, OWNER, encodeCall(sig, types, vals)));

const pendingDraw = async (c, farm, who) => {
  const r = await c.call(farm, OWNER, encodeCall('exiting(address)', ['address'], [who]));
  const w = r.replace(/^0x/, '').match(/.{64}/g) || [];
  return { amount: BigInt('0x' + w[0]), start: BigInt('0x' + w[1]), revealBlock: BigInt('0x' + w[2]) };
};

const balanceOf = async (c, qbtc, who) =>
  decodeUint(await c.call(qbtc, OWNER, encodeCall('balanceOf(address)', ['address'], [who])));

/* ------------------------------------------------------------------ MAIN */

async function main() {
  section('EMISSION SCHEDULE');
  {
    const { c, farm } = await deployStack();
    // The reference price is floored at one full rig rather than dividing by a
    // possibly-zero hashrate. Returning zero here would make coolant, repairs
    // and firewalls free whenever every staked rig had run itself to 0%.
    const daily0 = decodeUint(await c.call(farm, OWNER, encodeCall('fullRateDailyYield()', [], [])));
    // seasonRate truncates when dividing the season budget into seconds, so
    // the figure lands a few wei under the round number.
    check('the reference price holds up with nothing staked',
      near(daily0, 14_000n * ONE, 1) && daily0 > 0n, `${fmt(daily0)} qBTC/day`);

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
    const solo = await creditOf(c, farm, ALICE);

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
    const funded = await creditOf(c, farm, ALICE);
    check('settled yield is spendable at once', funded > 0n, `${fmt(funded)} qBTC of credit`);

    c.advanceTime(8 * DAY);
    const before = (await rigState(c, farm, ids[0])).durability;
    let threw = false;
    try {
      await c.call(farm, ALICE, encodeCall('repair(uint16[])', ['uint16[]'], [ids]));
    } catch (e) { threw = true; }
    const after = (await rigState(c, farm, ids[0])).durability;
    check('repair restores to full', !threw && after === 100, `${before} -> ${after}`);

    const spent = funded - (await creditOf(c, farm, ALICE));
    check('repair is paid out of credit, with no wallet balance at all',
      spent > 0n && (await balanceOf(c, qbtc, ALICE)) === 0n, `${fmt(spent)} qBTC spent`);
  }

  section('COOLANT');
  {
    const { c, game, farm, qbtc } = await deployStack();
    const ids = await getRigs(c, game, ALICE, 1);
    await stake(c, game, farm, ALICE, ids);
    c.advanceTime(DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [ids]));
    c.advanceTime(8 * DAY);

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

  section('THE FLOOR CURVE');
  {
    const { c, farm } = await deployStack();
    const floor = (elapsed) => readU(c, farm, 'withdrawFloorBps(uint256)', ['uint256'], [elapsed]);

    check('drawing at once guarantees nothing', (await floor(0)) === 0n);
    check('one day guarantees 20%', (await floor(DAY)) === 2000n);
    check('two days guarantee 40%', (await floor(2 * DAY)) === 4000n);
    check('three days guarantee 60%', (await floor(3 * DAY)) === 6000n);
    check('and it never climbs past 60%', (await floor(30 * DAY)) === 6000n);
  }

  section('WITHDRAWAL CAPS');
  {
    const { c, game, farm } = await deployStack();
    const ids = await getRigs(c, game, ALICE, 1);
    await stake(c, game, farm, ALICE, ids);
    // mine well past 20,000 qBTC, so a quarter of the balance sits above the
    // absolute cap and the two limits can be told apart
    c.advanceTime(DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [ids]));
    await c.call(farm, ALICE, encodeCall('refuel(uint16[],uint256)',
      ['uint16[]', 'uint256'], [ids, 7 * DAY]));
    c.advanceTime(7 * DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [ids]));
    const balance = await creditOf(c, farm, ALICE);
    check('a week of mining clears 20,000 qBTC of credit', balance > 20000n * ONE,
      `${fmt(balance)} qBTC`);

    const request = async (amount) => {
      try {
        await c.call(farm, ALICE, encodeCall('requestWithdraw(uint256)', ['uint256'], [amount]));
        return null;
      } catch (e) { return e.message; }
    };

    check('a quarter of the balance is refused once it passes 5,000 qBTC',
      (await request(balance / 4n)) !== null, `${fmt(balance / 4n)} of ${fmt(balance)}`);
    check('and so is anything above 5,000 qBTC', (await request(5001n * ONE)) !== null);
    check('a draw inside both caps is accepted', (await request(5000n * ONE)) === null);
    check('the credit leaves the balance the moment it is requested',
      (await creditOf(c, farm, ALICE)) === balance - 5000n * ONE);
    check('only one request may be outstanding', (await request(1000n * ONE)) !== null);
  }

  section('UPKEEP NEVER RESTARTS THE CLOCK');
  {
    // The defect this whole model replaces: the old escrow restarted its
    // seven-day clock on every settlement, so an active player could never
    // reach a full payout. Only requestWithdraw may write `start`.
    const { c, game, farm } = await deployStack();
    const ids = await getRigs(c, game, ALICE, 1);
    await stake(c, game, farm, ALICE, ids);
    c.advanceTime(DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [ids]));

    await c.call(farm, ALICE, encodeCall('requestWithdraw(uint256)', ['uint256'], [1000n * ONE]));
    const opened = (await pendingDraw(c, farm, ALICE)).start;

    // three days of ordinary play: refuel, claim, refuel again
    for (let d = 0; d < 3; d++) {
      await c.call(farm, ALICE, encodeCall('refuel(uint16[],uint256)',
        ['uint16[]', 'uint256'], [ids, DAY]));
      c.advanceTime(DAY);
      await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [ids]));
    }

    const after = await pendingDraw(c, farm, ALICE);
    check('three days of upkeep left the clock alone', after.start === opened,
      `started at ${opened}, still ${after.start}`);
    check('so the guarantee has reached its maximum',
      (await readU(c, farm, 'withdrawFloorBps(uint256)', ['uint256'],
        [Number(BigInt(c.timestamp) - opened)])) === 6000n);
  }

  section('THE DRAW');
  {
    const { c, game, farm, qbtc } = await deployStack();
    const ids = await getRigs(c, game, ALICE, 1);
    await stake(c, game, farm, ALICE, ids);
    c.advanceTime(DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [ids]));

    const AMOUNT = 1000n * ONE;
    await c.call(farm, ALICE, encodeCall('requestWithdraw(uint256)', ['uint256'], [AMOUNT]));

    let threw = false;
    try { await c.call(farm, ALICE, encodeCall('settleWithdraw()', [], [])); }
    catch (e) { threw = true; }
    check('cannot settle in the block the draw was requested', threw);

    // Wait out the window, then settle: floor is 60%, so the flip decides
    // between 600 and 1000 and nothing worse. Three days is far past the
    // 256-block anchor, so the first press only re-anchors.
    c.advanceTime(3 * DAY);
    const walletBefore = await balanceOf(c, qbtc, ALICE);
    await c.call(farm, BOB, encodeCall('settleWithdraw(address)', ['address'], [ALICE]));
    c.advance(2);
    await c.call(farm, BOB, encodeCall('settleWithdraw(address)', ['address'], [ALICE]));
    const paid = (await balanceOf(c, qbtc, ALICE)) - walletBefore;

    check('anyone may settle, and it pays the owner not the caller',
      paid > 0n && (await balanceOf(c, qbtc, BOB)) === 0n, `${fmt(paid)} qBTC`);
    check('a patient draw pays either the floor or the lot',
      paid === AMOUNT || paid === (AMOUNT * 6000n) / 10000n,
      `${fmt(paid)} of ${fmt(AMOUNT)}`);
    check('the request is consumed', (await pendingDraw(c, farm, ALICE)).amount === 0n);
  }

  section('A LOST DRAW IS HALF BURNED, HALF FED TO THE DREY');
  {
    // Paying the whole loss to the Drey refunds a large holder most of their
    // own loss, which is the hole the split closes. Both halves are checked on
    // whichever attempt the coin flip goes against.
    const { c, game, farm, qbtc } = await deployStack();
    const ids = await getRigs(c, game, ALICE, 1);
    let squirrel = 0;
    const supply = Number(decodeUint(await c.call(game, OWNER, encodeCall('minted()', [], []))));
    for (let id = 1; id <= supply && !squirrel; id++) {
      const t = await traitsOf(c, game, id);
      const o = decodeAddress(await c.call(game, OWNER,
        encodeCall('ownerOf(uint256)', ['uint256'], [id])));
      if (!t.isQuantum && o === ALICE.toLowerCase()) squirrel = id;
    }
    await stake(c, game, farm, ALICE, squirrel ? [...ids, squirrel] : ids);
    c.advanceTime(DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [ids]));

    const AMOUNT = 1000n * ONE;
    let sawWin = false, sawLoss = false, checked = false;
    for (let attempt = 0; attempt < 12 && !(sawWin && sawLoss); attempt++) {
      if ((await creditOf(c, farm, ALICE)) < AMOUNT * 4n) break;
      await c.call(farm, ALICE, encodeCall('requestWithdraw(uint256)', ['uint256'], [AMOUNT]));
      c.advance(2);

      const burnedBefore = await readU(c, farm, 'totalBurned()');
      const dreyBefore = await readU(c, farm, 'qbtcPerAlpha()');
      const unaccountedBefore = await readU(c, farm, 'unaccountedTax()');
      const walletBefore = await balanceOf(c, qbtc, ALICE);
      await c.call(farm, ALICE, encodeCall('settleWithdraw()', [], []));
      const paid = (await balanceOf(c, qbtc, ALICE)) - walletBefore;

      if (paid === AMOUNT) { sawWin = true; continue; }
      sawLoss = true;
      if (checked) continue;
      checked = true;

      // Drawn two blocks after the request, so the floor has barely left zero:
      // the impatient path keeps essentially nothing when the flip goes against
      // it, which is the whole reason the floor exists for everyone else.
      const lost = AMOUNT - paid;
      check('a draw taken at once keeps next to nothing', paid < AMOUNT / 100n,
        `${fmt(paid)} paid, ${fmt(lost)} lost`);
      check('half of the loss is burned',
        (await readU(c, farm, 'totalBurned()')) - burnedBefore === lost / 2n,
        `${fmt(lost / 2n)} qBTC`);
      const toDrey = squirrel
        ? (await readU(c, farm, 'qbtcPerAlpha()')) - dreyBefore
        : (await readU(c, farm, 'unaccountedTax()')) - unaccountedBefore;
      check('and the other half is handed to the Drey rather than destroyed',
        toDrey > 0n, squirrel ? `${fmt(toDrey)} per alpha` : `${fmt(toDrey)} qBTC held for the Drey`);
    }
    check('both outcomes of the coin flip occur', sawWin && sawLoss,
      `win ${sawWin}, loss ${sawLoss}`);
  }

  section('A DEAD ANCHOR RE-ANCHORS ITSELF');
  {
    // Block hashes survive 256 blocks (~4.3h) while the odds clock runs three
    // days, so the anchor MUST be re-takeable — and re-taking it must not touch
    // the odds clock, or the curve is decorative.
    const { c, game, farm, qbtc } = await deployStack();
    const ids = await getRigs(c, game, ALICE, 1);
    await stake(c, game, farm, ALICE, ids);
    c.advanceTime(DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [ids]));

    const AMOUNT = 1000n * ONE;
    await c.call(farm, ALICE, encodeCall('requestWithdraw(uint256)', ['uint256'], [AMOUNT]));
    const opened = await pendingDraw(c, farm, ALICE);

    c.advanceTime(3 * DAY); // far past the 256-block window
    const walletBefore = await balanceOf(c, qbtc, ALICE);
    await c.call(farm, ALICE, encodeCall('settleWithdraw()', [], []));
    const midway = await pendingDraw(c, farm, ALICE);

    check('the first press re-anchors and pays nothing',
      midway.amount === AMOUNT && (await balanceOf(c, qbtc, ALICE)) === walletBefore);
    check('on a fresh block hash', midway.revealBlock > opened.revealBlock,
      `${opened.revealBlock} -> ${midway.revealBlock}`);
    check('and the odds clock is untouched', midway.start === opened.start);

    c.advance(2);
    await c.call(farm, ALICE, encodeCall('settleWithdraw()', [], []));
    const paid = (await balanceOf(c, qbtc, ALICE)) - walletBefore;
    check('the second press draws, at the full three-day terms',
      paid === AMOUNT || paid === (AMOUNT * 6000n) / 10000n, `${fmt(paid)} qBTC`);
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
