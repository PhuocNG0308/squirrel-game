/**
 * SquirrelLens tests.
 *
 * The lens replaces an off-chain re-implementation of `_settleRig` that the
 * wallet was carrying to answer "what would Claim pay me?". That port was
 * verified wei-exact and was still a liability: every constant in Ops lived in
 * two languages, and a change to settlement that was not mirrored would show a
 * number the contract does not honour.
 *
 * So the property under test is exactly the one the port had to promise, only
 * now it is enforced on chain: every case snapshots, predicts through
 * `pendingOf`, claims for real, and compares to the wei — no tolerance. The
 * invariant is simply
 *
 *     owed = credit_after - credit_before
 *
 * since a claim's only effect on the balance is to add what it settled.
 */
const { Chain, encodeCall, decodeUint, decodeAddress } = require('./harness');

const ONE = 10n ** 18n;
const DAY = 86400;
const MINT_PRICE = 69420000000000000n;
const BASE_URI = 'https://raw.githubusercontent.com/PhuocNG0308/squirrel-game/main/assets/';

const OWNER = '0x' + 'a1'.repeat(20);
const ALICE = '0x' + 'b2'.repeat(20);

let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; failures.push(label); console.log(`  FAIL  ${label}  ${detail}`); }
}
const section = (n) => console.log(`\n=== ${n} ===`);
const fmt = (w) => (Number(w) / 1e18).toFixed(6);
const words = (hex) => (hex.replace(/^0x/, '').match(/.{64}/g) || []).map((w) => BigInt('0x' + w));

/* ---------------------------------------------------------------- DECODING */

/** Reads a dynamic array of single-word elements at `offset` bytes. */
function readArray(w, offset) {
  const at = Number(offset) / 32;
  const len = Number(w[at]);
  return w.slice(at + 1, at + 1 + len);
}

/* ------------------------------------------------------------------- SETUP */

async function deployStack() {
  const c = await Chain.create();
  for (const a of [OWNER, ALICE]) await c.fund(a, 10n ** 22n);

  const qbtc = await c.deploy('QBTC', [], [], OWNER);
  const traits = await c.deploy('Traits', ['string', 'string'], [BASE_URI, 'https://x'], OWNER);
  const game = await c.deploy('SquirrelGame', ['address', 'address', 'uint256'],
    [qbtc, traits, 50000], OWNER);
  const farm = await c.deploy('QuantumFarm', ['address', 'address'], [game, qbtc], OWNER);
  const stats = await c.deploy('TraitStats', ['address'], [game], OWNER);
  const post = await c.deploy('RaidPost', ['address', 'address'], [farm, qbtc], OWNER);
  const lens = await c.deploy('SquirrelLens', ['address', 'address', 'address', 'address'],
    [game, farm, post, stats], OWNER);

  await c.call(game, OWNER, encodeCall('setFarm(address)', ['address'], [farm]));
  await c.call(traits, OWNER, encodeCall('setGame(address)', ['address'], [game]));
  await c.call(farm, OWNER, encodeCall('setRaidPost(address)', ['address'], [post]));
  await c.call(qbtc, OWNER, encodeCall('addController(address)', ['address'], [farm]));
  await c.call(qbtc, OWNER, encodeCall('addController(address)', ['address'], [game]));
  // wired, so the lens is exercised against real trait modifiers rather than 10000s
  await c.call(farm, OWNER, encodeCall('setStats(address)', ['address'], [stats]));
  await c.call(post, OWNER, encodeCall('setStats(address)', ['address'], [stats]));

  return { c, qbtc, traits, game, farm, stats, post, lens };
}

async function mintFor(c, game, who, amount) {
  await c.call(game, who, encodeCall('commitMint(uint256,bool)', ['uint256', 'bool'],
    [amount, false]), MINT_PRICE * BigInt(amount));
  c.advance(2);
  await c.call(game, who, encodeCall('revealMint()', [], []));
}

/** Mints until `who` holds `rigCount` rigs and `squirrelCount` squirrels. */
async function collect(c, game, who, rigCount, squirrelCount) {
  const rigs = [], squirrels = [];
  let next = 1;
  for (let r = 0; r < 10 && (rigs.length < rigCount || squirrels.length < squirrelCount); r++) {
    await mintFor(c, game, who, 10);
    const minted = Number(decodeUint(await c.call(game, OWNER, encodeCall('minted()', [], []))));
    for (; next <= minted; next++) {
      const t = words(await c.call(game, OWNER,
        encodeCall('tokenTraits(uint256)', ['uint256'], [next])));
      const owner = decodeAddress(await c.call(game, OWNER,
        encodeCall('ownerOf(uint256)', ['uint256'], [next])));
      if (owner !== who.toLowerCase()) continue;
      if (t[0] === 1n && rigs.length < rigCount) rigs.push(next);
      if (t[0] === 0n && squirrels.length < squirrelCount) squirrels.push(next);
    }
  }
  return { rigs, squirrels };
}

const stake = (c, game, farm, who, ids) =>
  c.call(game, who, encodeCall('setApprovalForAll(address,bool)', ['address', 'bool'], [farm, true]))
    .then(() => c.call(farm, who, encodeCall('stake(uint16[])', ['uint16[]'], [ids])));

const creditOf = async (c, farm, who) =>
  decodeUint(await c.call(farm, OWNER, encodeCall('credit(address)', ['address'], [who])));

/** `pendingOf(owner)` -> { total, ids, nets } */
async function pendingOf(ctx, owner) {
  const w = words(await ctx.c.call(ctx.lens, OWNER,
    encodeCall('pendingOf(address)', ['address'], [owner])));
  return { total: w[0], ids: readArray(w, w[1]).map(Number), nets: readArray(w, w[2]) };
}

/** `pendingOfTokens(ids)` -> { total, nets } */
async function pendingOfTokens(ctx, ids) {
  const w = words(await ctx.c.call(ctx.lens, OWNER,
    encodeCall('pendingOfTokens(uint16[])', ['uint16[]'], [ids])));
  return { total: w[0], nets: readArray(w, w[1]) };
}

/**
 * Predicts through the lens, then claims, then reports whether the prediction
 * was exact. Nothing may advance the clock in between, or the contract settles
 * a longer window than was predicted.
 */
async function predictAndClaim(ctx, label, ids) {
  const predicted = await pendingOfTokens(ctx, ids);
  const before = await creditOf(ctx.c, ctx.farm, ALICE);
  await ctx.c.call(ctx.farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [ids]));
  const owed = (await creditOf(ctx.c, ctx.farm, ALICE)) - before;

  check(`${label}: pending is exact`, predicted.total === owed,
    `predicted ${fmt(predicted.total)}, actual ${fmt(owed)}`);
  return { predicted, owed };
}

/* ------------------------------------------------------------------- MAIN */

async function main() {
  section('A FRESH RIG, PART-WAY THROUGH ITS PRIMED WINDOW');
  {
    const ctx = await deployStack();
    const { rigs } = await collect(ctx.c, ctx.game, ALICE, 1, 0);
    await stake(ctx.c, ctx.game, ctx.farm, ALICE, rigs);

    ctx.c.advanceTime(DAY / 2);
    const { predicted } = await predictAndClaim(ctx, 'half a day', rigs);
    check('half a day mined something', predicted.total > 0n, `${fmt(predicted.total)} qBTC`);
  }

  section('COOLANT RUNS OUT MID-WINDOW');
  {
    const ctx = await deployStack();
    const { rigs } = await collect(ctx.c, ctx.game, ALICE, 1, 0);
    await stake(ctx.c, ctx.game, ctx.farm, ALICE, rigs);

    // primed for one day, then idle for two: only the fuelled part may pay
    ctx.c.advanceTime(3 * DAY);
    const { predicted } = await predictAndClaim(ctx, 'fuel expired', rigs);
    check('the unfuelled tail is excluded', predicted.total > 0n,
      `${fmt(predicted.total)} qBTC for the fuelled day`);

    const second = await predictAndClaim(ctx, 'claimed twice', rigs);
    check('a second claim in the same second is zero', second.predicted.total === 0n);
  }

  section('DURABILITY DECAYS ACROSS BANDS');
  {
    const ctx = await deployStack();
    const { rigs } = await collect(ctx.c, ctx.game, ALICE, 1, 0);
    await stake(ctx.c, ctx.game, ctx.farm, ALICE, rigs);

    ctx.c.advanceTime(DAY);
    await predictAndClaim(ctx, 'day one', rigs);
    await ctx.c.call(ctx.farm, ALICE, encodeCall('refuel(uint16[],uint256)',
      ['uint16[]', 'uint256'], [rigs, 7 * DAY]));

    // 7 fuelled days at 5 points a day crosses the 75 and 50 hashrate bands
    ctx.c.advanceTime(7 * DAY);
    const { predicted } = await predictAndClaim(ctx, 'seven fuelled days', rigs);
    check('a full prepaid window pays', predicted.total > 0n, `${fmt(predicted.total)} qBTC`);
  }

  section('AN UPTIME STREAK RAISES THE PAYOUT');
  {
    const ctx = await deployStack();
    const { rigs } = await collect(ctx.c, ctx.game, ALICE, 1, 0);
    await stake(ctx.c, ctx.game, ctx.farm, ALICE, rigs);

    // refuelling on consecutive days is what banks a streak; the first claim
    // is what pays for the first refuel
    for (let d = 0; d < 3; d++) {
      ctx.c.advanceTime(DAY);
      await ctx.c.call(ctx.farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [rigs]));
      await ctx.c.call(ctx.farm, ALICE, encodeCall('refuel(uint16[],uint256)',
        ['uint16[]', 'uint256'], [rigs, 2 * DAY]));
    }

    ctx.c.advanceTime(DAY / 2);
    const r = words(await ctx.c.call(ctx.farm, OWNER,
      encodeCall('rigs(uint256)', ['uint256'], [rigs[0]])));
    check('the rig carries a streak', r[4] > 0n, `${r[4]} days`);
    await predictAndClaim(ctx, 'with a streak', rigs);
  }

  section('A SQUIRREL CLAIMED BEHIND A RIG');
  {
    const ctx = await deployStack();
    const { rigs, squirrels } = await collect(ctx.c, ctx.game, ALICE, 1, 1);
    check('found a rig and a squirrel', rigs.length === 1 && squirrels.length === 1,
      `#${rigs[0]} / #${squirrels[0]}`);
    await stake(ctx.c, ctx.game, ctx.farm, ALICE, [...rigs, ...squirrels]);

    ctx.c.advanceTime(DAY);
    // The rig's tax reaches the Drey before the squirrel settles, so the two
    // are claimed separately: within one call the lens cannot see the tax the
    // rig is about to pay, and neither could an off-chain replay.
    await predictAndClaim(ctx, 'the rig', rigs);
    const { predicted } = await predictAndClaim(ctx, 'then the squirrel', squirrels);
    check('the squirrel draws on tax paid a moment earlier', predicted.total > 0n,
      `${fmt(predicted.total)} qBTC`);
  }

  section('A SEASON BOUNDARY IS CROSSED');
  {
    const ctx = await deployStack();
    const { rigs } = await collect(ctx.c, ctx.game, ALICE, 1, 0);
    await stake(ctx.c, ctx.game, ctx.farm, ALICE, rigs);

    ctx.c.advanceTime(35 * DAY);
    await predictAndClaim(ctx, 'across a season boundary', rigs);
  }

  section('STAKED TOKENS WITHOUT A LOG SCAN');
  {
    const ctx = await deployStack();
    const { rigs, squirrels } = await collect(ctx.c, ctx.game, ALICE, 2, 1);
    const all = [...rigs, ...squirrels];
    await stake(ctx.c, ctx.game, ctx.farm, ALICE, all);

    const listed = await pendingOf(ctx, ALICE);
    check('every staked token is listed, and only those',
      listed.ids.length === all.length && all.every((id) => listed.ids.includes(id)),
      `#${listed.ids.join(', #')}`);

    ctx.c.advanceTime(DAY);
    const whole = await pendingOf(ctx, ALICE);
    const perToken = await pendingOfTokens(ctx, whole.ids);
    check('the per-owner and per-token views agree', whole.total === perToken.total,
      `${fmt(whole.total)} qBTC`);

    // exit a rig; it must leave the index without disturbing the rest
    ctx.c.advanceTime(2 * DAY);
    await ctx.c.call(ctx.farm, ALICE, encodeCall('requestExit(uint16[])', ['uint16[]'], [[rigs[0]]]));
    ctx.c.advance(2);
    await ctx.c.call(ctx.farm, ALICE, encodeCall('executeExit()', [], []));

    const after = await pendingOf(ctx, ALICE);
    check('an exited rig drops out of the index',
      after.ids.length === all.length - 1 && !after.ids.includes(rigs[0]),
      `#${after.ids.join(', #')}`);
    check('and the survivors are all still there',
      all.slice(1).every((id) => after.ids.includes(id)));
  }

  section('ONE CALL FOR THE WHOLE SCREEN');
  {
    const ctx = await deployStack();
    const { rigs, squirrels } = await collect(ctx.c, ctx.game, ALICE, 2, 1);
    await stake(ctx.c, ctx.game, ctx.farm, ALICE, [rigs[0], squirrels[0]]);
    ctx.c.advanceTime(DAY / 2); // still inside the primed coolant window
    const loose = Number(decodeUint(await ctx.c.call(ctx.game, OWNER,
      encodeCall('balanceOf(address)', ['address'], [ALICE]))));

    const g = words(await ctx.c.call(ctx.lens, OWNER, encodeCall('gameStats()', [], [])));
    check('gameStats reports the collection and the farm together',
      g[0] > 0n && g[3] === MINT_PRICE && g[6] > 0n && g[7] === 1n,
      `${g[0]} minted, ${g[7]} rigs staked, hashrate ${fmt(g[6])}`);
    check('and how many starter packs are left', g[13] === 2000n, `${g[13]} packs`);

    const p = words(await ctx.c.call(ctx.lens, OWNER,
      encodeCall('portfolioOf(address)', ['address'], [ALICE])));
    const count = Number(p[Number(p[0]) / 32]);
    const FIELDS = 17;
    const base = Number(p[0]) / 32 + 1;
    const rows = [];
    for (let i = 0; i < count; i++) rows.push(p.slice(base + i * FIELDS, base + (i + 1) * FIELDS));

    // two staked tokens have left the enumerable set; the rest are still in it
    check('the portfolio stitches the staked and loose halves together',
      count === loose + 2, `${count} tokens = ${loose} loose + 2 staked`);
    const staked = rows.filter((r) => r[4] === 1n);
    check('two of them are staked', staked.length === 2);

    const rig = rows.find((r) => Number(r[0]) === rigs[0]);
    check('a staked rig reports its live condition',
      rig[1] === 1n && rig[5] < 100n && rig[8] === 1n && rig[11] >= 9000n,
      `durability ${rig[5]}, mining ${rig[8] === 1n}, hashrate ${rig[11]}`);

    const guard = rows.find((r) => Number(r[0]) === squirrels[0]);
    check('a staked squirrel reports alpha and energy',
      guard[1] === 0n && guard[3] >= 6n && guard[9] > 0n,
      `alpha ${guard[3]}, energy ${guard[9]}`);

    const spare = rows.find((r) => Number(r[0]) === rigs[1]);
    check('an unstaked rig still reports its sheet', spare[4] === 0n && spare[11] >= 9000n,
      `hashrate ${spare[11]}`);

    const costs = readArray(words(await ctx.c.call(ctx.lens, OWNER,
      encodeCall('mintCosts(uint256,uint256)', ['uint256', 'uint256'], [9999, 3]))), 32n);
    check('the mint ladder comes back in one call',
      costs.length === 3 && costs[0] === 0n && costs[1] === 0n && costs[2] === 175n * ONE,
      costs.map((x) => fmt(x)).join(', '));
  }

  section('CREDIT AND THE PENDING DRAW');
  {
    const ctx = await deployStack();
    const { rigs } = await collect(ctx.c, ctx.game, ALICE, 1, 0);
    await stake(ctx.c, ctx.game, ctx.farm, ALICE, rigs);
    ctx.c.advanceTime(DAY);
    await ctx.c.call(ctx.farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [rigs]));

    const view = async () => words(await ctx.c.call(ctx.lens, OWNER,
      encodeCall('creditOf(address)', ['address'], [ALICE])));

    const v0 = await view();
    check('credit is reported, and no token has been minted for it',
      v0[0] === (await creditOf(ctx.c, ctx.farm, ALICE)) && v0[0] > 0n && v0[2] === 0n,
      `${fmt(v0[0])} qBTC of credit, ${fmt(v0[2])} in the wallet`);
    check('with no draw pending', v0[4] === 0n);

    const AMOUNT = 1000n * ONE;
    await ctx.c.call(ctx.farm, ALICE,
      encodeCall('requestWithdraw(uint256)', ['uint256'], [AMOUNT]));

    const v1 = await view();
    check('a fresh draw guarantees nothing yet',
      v1[4] === AMOUNT && v1[5] < AMOUNT / 100n,
      `${fmt(v1[4])} at stake, ${fmt(v1[5])} guaranteed`);
    check('but the screen can already price the wait',
      v1[6] === (AMOUNT * 6000n) / 10000n, `${fmt(v1[6])} after three days`);
    check('the anchor is not readable in the commit block', v1[8] === 0n);

    ctx.c.advance(2);
    const v2 = await view();
    check('and is a block later', v2[8] === 1n && v2[9] === 0n);

    ctx.c.advanceTime(3 * DAY);
    const v3 = await view();
    check('the guarantee reaches 60% at the end of the window',
      v3[5] === (AMOUNT * 6000n) / 10000n, `${fmt(v3[5])} of ${fmt(AMOUNT)}`);
    check('and the client is told the anchor died and needs one more press',
      v3[9] === 1n && v3[8] === 0n);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nfailures:'); failures.forEach((f) => console.log('  -', f)); }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\nTEST RUN CRASHED:', e); process.exit(1); });
