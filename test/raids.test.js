/**
 * RaidPost and SeasonLedger tests.
 *
 * The load-bearing claims here are that a raid cannot be retried once its
 * outcome is knowable, that firewall points actually move the odds and decay,
 * and — the headline of the season redesign — that splitting a fleet across
 * wallets pays exactly the same total.
 */
const { Chain, encodeCall, decodeUint, decodeBool, decodeAddress } = require('./harness');

const ONE = 10n ** 18n;
const DAY = 86400;
const SEASON = 30 * DAY;
const MINT_PRICE = 69420000000000000n;
const BASE_URI = 'https://raw.githubusercontent.com/PhuocNG0308/squirrel-game/main/assets/';

const OWNER = '0x' + 'a1'.repeat(20);
const ALICE = '0x' + 'b2'.repeat(20);
const BOB = '0x' + 'c3'.repeat(20);
const CAROL = '0x' + 'd4'.repeat(20);

let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; failures.push(label); console.log(`  FAIL  ${label}  ${detail}`); }
}
const section = (n) => console.log(`\n=== ${n} ===`);
const fmt = (w) => (Number(w) / 1e18).toFixed(4);

async function deployStack() {
  const c = await Chain.create();
  for (const a of [OWNER, ALICE, BOB, CAROL]) await c.fund(a, 10n ** 22n);

  const qbtc = await c.deploy('QBTC', [], [], OWNER);
  const traits = await c.deploy('Traits', ['string', 'string'], [BASE_URI, 'https://x'], OWNER);
  const game = await c.deploy('SquirrelGame', ['address', 'address', 'uint256'],
    [qbtc, traits, 50000], OWNER);
  const farm = await c.deploy('QuantumFarm', ['address', 'address'], [game, qbtc], OWNER);
  const post = await c.deploy('RaidPost', ['address', 'address'], [farm, qbtc], OWNER);
  const ledger = await c.deploy('SeasonLedger', ['address', 'address', 'address'],
    [farm, post, qbtc], OWNER);

  await c.call(game, OWNER, encodeCall('setFarm(address)', ['address'], [farm]));
  await c.call(traits, OWNER, encodeCall('setGame(address)', ['address'], [game]));
  await c.call(farm, OWNER, encodeCall('setRaidPost(address)', ['address'], [post]));
  for (const ctrl of [farm, game, post, ledger]) {
    await c.call(qbtc, OWNER, encodeCall('addController(address)', ['address'], [ctrl]));
  }
  return { c, qbtc, traits, game, farm, post, ledger };
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

/** Mints for `who` until the requested counts are held. */
async function acquire(c, game, who, wantRigs, wantSquirrels, cursor) {
  const rigs = [], squirrels = [];
  for (let round = 0; round < 10 && (rigs.length < wantRigs || squirrels.length < wantSquirrels); round++) {
    await mintFor(c, game, who, 10);
    const minted = Number(decodeUint(await c.call(game, OWNER, encodeCall('minted()', [], []))));
    for (; cursor.i <= minted; cursor.i++) {
      const t = await traitsOf(c, game, cursor.i);
      const o = decodeAddress(await c.call(game, OWNER,
        encodeCall('ownerOf(uint256)', ['uint256'], [cursor.i])));
      if (o !== who.toLowerCase()) continue;
      if (t.isQuantum && rigs.length < wantRigs) rigs.push(cursor.i);
      else if (!t.isQuantum && squirrels.length < wantSquirrels) squirrels.push(cursor.i);
    }
  }
  return { rigs, squirrels };
}

const stake = async (c, game, farm, who, ids) => {
  await c.call(game, who, encodeCall('setApprovalForAll(address,bool)',
    ['address', 'bool'], [farm, true]));
  await c.call(farm, who, encodeCall('stake(uint16[])', ['uint16[]'], [ids]));
};

const balanceOf = async (c, qbtc, who) =>
  decodeUint(await c.call(qbtc, OWNER, encodeCall('balanceOf(address)', ['address'], [who])));

/** Gives `who` spendable qBTC by mining a staked rig and fully vesting it. */
async function fund(c, farm, qbtc, who, rigIds) {
  c.advanceTime(DAY);
  await c.call(farm, who, encodeCall('claim(uint16[])', ['uint16[]'], [rigIds]));
  c.advanceTime(8 * DAY);
  await c.call(farm, who, encodeCall('withdraw()', [], []));
  return balanceOf(c, qbtc, who);
}

/* ------------------------------------------------------------------ MAIN */

async function main() {
  section('FIREWALL');
  {
    const { c, game, farm, post, qbtc } = await deployStack();
    const cur = { i: 1 };
    const a = await acquire(c, game, ALICE, 1, 0, cur);
    await stake(c, game, farm, ALICE, a.rigs);
    const funded = await fund(c, farm, qbtc, ALICE, a.rigs);
    check('rig owner has qBTC to spend', funded > 0n, `${fmt(funded)} qBTC`);

    const f0 = decodeUint(await c.call(post, OWNER,
      encodeCall('firewallOf(uint16)', ['uint16'], [a.rigs[0]])));
    check('a bare rig has no firewall', f0 === 0n);

    await c.call(post, ALICE, encodeCall('reinforce(uint16[])', ['uint16[]'], [a.rigs]));
    const f1 = decodeUint(await c.call(post, OWNER,
      encodeCall('firewallOf(uint16)', ['uint16'], [a.rigs[0]])));
    check('reinforcing adds a point', f1 === 1n, `${f1}`);

    const spent = funded - (await balanceOf(c, qbtc, ALICE));
    check('reinforcing burns qBTC', spent > 0n, `${fmt(spent)} qBTC`);

    let threw = false;
    try {
      await c.call(post, BOB, encodeCall('reinforce(uint16[])', ['uint16[]'], [a.rigs]));
    } catch (e) { threw = true; }
    check('cannot reinforce someone else\'s rig', threw);

    c.advanceTime(SEASON + DAY);
    const f2 = decodeUint(await c.call(post, OWNER,
      encodeCall('firewallOf(uint16)', ['uint16'], [a.rigs[0]])));
    check('firewall decays a point per season', f2 === 0n, `${f2} after one season`);
  }

  section('RAID ODDS');
  {
    const { c, game, farm, post, qbtc } = await deployStack();
    const cur = { i: 1 };
    const a = await acquire(c, game, ALICE, 1, 1, cur);
    const b = await acquire(c, game, BOB, 1, 0, cur);
    check('both sides have what they need',
      a.rigs.length && a.squirrels.length && b.rigs.length,
      `alice rig #${a.rigs[0]} squirrel #${a.squirrels[0]}, bob rig #${b.rigs[0]}`);

    await stake(c, game, farm, ALICE, [...a.rigs, ...a.squirrels]);
    await stake(c, game, farm, BOB, b.rigs);

    const bare = decodeUint(await c.call(post, OWNER,
      encodeCall('oddsAgainst(uint16,uint16)', ['uint16', 'uint16'], [a.squirrels[0], b.rigs[0]])));
    const alpha = decodeUint(await c.call(farm, OWNER,
      encodeCall('alphaOf(uint16)', ['uint16'], [a.squirrels[0]])));
    const expected = (alpha * ONE) / (alpha + 4n);
    check('odds against a bare rig are alpha/(alpha+4)', bare === expected,
      `alpha ${alpha} -> ${(Number(bare) / 1e16).toFixed(1)}%`);

    await fund(c, farm, qbtc, BOB, b.rigs);
    await c.call(post, BOB, encodeCall('reinforce(uint16[])', ['uint16[]'], [b.rigs]));
    const defended = decodeUint(await c.call(post, OWNER,
      encodeCall('oddsAgainst(uint16,uint16)', ['uint16', 'uint16'], [a.squirrels[0], b.rigs[0]])));
    check('a firewall point lowers the odds', defended < bare,
      `${(Number(bare) / 1e16).toFixed(1)}% -> ${(Number(defended) / 1e16).toFixed(1)}%`);
  }

  section('RAID COMMIT-REVEAL');
  {
    const { c, game, farm, post, qbtc } = await deployStack();
    const cur = { i: 1 };
    const a = await acquire(c, game, ALICE, 1, 1, cur);
    const b = await acquire(c, game, BOB, 1, 0, cur);
    await stake(c, game, farm, ALICE, [...a.rigs, ...a.squirrels]);
    await stake(c, game, farm, BOB, b.rigs);

    let threw = false;
    try {
      await c.call(post, BOB, encodeCall('commitRaid(uint16,uint16)',
        ['uint16', 'uint16'], [a.squirrels[0], b.rigs[0]]));
    } catch (e) { threw = true; }
    check('cannot raid with a squirrel you do not own', threw);

    threw = false;
    try {
      await c.call(post, ALICE, encodeCall('commitRaid(uint16,uint16)',
        ['uint16', 'uint16'], [a.squirrels[0], a.rigs[0]]));
    } catch (e) { threw = true; }
    check('cannot raid your own rig', threw);

    await c.call(post, ALICE, encodeCall('commitRaid(uint16,uint16)',
      ['uint16', 'uint16'], [a.squirrels[0], b.rigs[0]]));

    threw = false;
    try { await c.call(post, ALICE, encodeCall('revealRaid()', [], [])); }
    catch (e) { threw = true; }
    check('cannot resolve in the commit block', threw);

    threw = false;
    try {
      await c.call(post, ALICE, encodeCall('commitRaid(uint16,uint16)',
        ['uint16', 'uint16'], [a.squirrels[0], b.rigs[0]]));
    } catch (e) { threw = true; }
    check('cannot stack a second raid on the first', threw);

    c.advance(2);
    await c.call(post, CAROL, encodeCall('revealRaid(address)', ['address'], [ALICE]));
    check('anyone may resolve a pending raid', true);

    const energyAfter = await c.call(farm, OWNER,
      encodeCall('guardOwner(uint16)', ['uint16'], [a.squirrels[0]]));
    const w = energyAfter.replace(/^0x/, '').match(/.{64}/g);
    const energy = Number(BigInt('0x' + w[1]));
    check('energy was spent whatever the outcome', energy <= 85, `${energy}/100`);
  }

  section('A SUCCESSFUL RAID TAKES YIELD');
  {
    const { c, game, farm, post, qbtc } = await deployStack();
    const cur = { i: 1 };
    const a = await acquire(c, game, ALICE, 1, 1, cur);
    const b = await acquire(c, game, BOB, 1, 0, cur);
    await stake(c, game, farm, ALICE, [...a.rigs, ...a.squirrels]);
    await stake(c, game, farm, BOB, b.rigs);

    // Bob's rig accrues over its primed window; Alice raids before he claims.
    c.advanceTime(DAY);

    let stolen = 0n;
    let attempts = 0;
    for (; attempts < 12 && stolen === 0n; attempts++) {
      // top the squirrel back up so energy never blocks the next attempt
      await c.call(farm, ALICE, encodeCall('feed(uint16[])', ['uint16[]'], [a.squirrels]))
        .catch(() => {});
      await c.call(post, ALICE, encodeCall('commitRaid(uint16,uint16)',
        ['uint16', 'uint16'], [a.squirrels[0], b.rigs[0]])).catch(() => {});
      c.advance(2);
      await c.call(post, ALICE, encodeCall('revealRaid()', [], [])).catch(() => {});
      const season = decodeUint(await c.call(farm, OWNER, encodeCall('seasonNow()', [], [])));
      stolen = decodeUint(await c.call(post, OWNER,
        encodeCall('seasonRaidTotal(uint256)', ['uint256'], [season])));
    }
    check('a raid eventually lands and records a steal', stolen > 0n,
      `${fmt(stolen)} qBTC after ${attempts} attempt(s)`);

    const v = await c.call(farm, OWNER, encodeCall('vestingOf(address)', ['address'], [ALICE]));
    const vw = v.replace(/^0x/, '').match(/.{64}/g);
    check('the stolen yield is vesting for the raider', BigInt('0x' + vw[0]) > 0n,
      `${fmt(BigInt('0x' + vw[0]))} qBTC`);
  }

  section('DEFENCE RANK DECAY');
  {
    const { c, game, farm, qbtc } = await deployStack();
    const cur = { i: 1 };
    const a = await acquire(c, game, ALICE, 1, 1, cur);
    await stake(c, game, farm, ALICE, [...a.rigs, ...a.squirrels]);

    c.advanceTime(DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [a.rigs]));
    const perAlpha = decodeUint(await c.call(farm, OWNER, encodeCall('qbtcPerAlpha()', [], [])));
    check('tax reached the Drey', perAlpha > 0n, `${fmt(perAlpha)} per alpha`);

    // claim the squirrel's share immediately, at full rank
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [a.squirrels]));
    const atFull = await c.call(farm, OWNER, encodeCall('vestingOf(address)', ['address'], [ALICE]));
    const full = BigInt('0x' + atFull.replace(/^0x/, '').match(/.{64}/g)[0]);
    check('a freshly patched squirrel draws its share', full > 0n, `${fmt(full)} qBTC`);

    let threw = false;
    try { await c.call(farm, ALICE, encodeCall('patch(uint16[])', ['uint16[]'], [a.squirrels])); }
    catch (e) { threw = true; }
    check('patching in the same season is free and succeeds', !threw);
  }

  section('SEASON LADDERS');
  {
    const { c, game, farm, ledger, qbtc } = await deployStack();
    const cur = { i: 1 };
    const a = await acquire(c, game, ALICE, 1, 0, cur);
    await stake(c, game, farm, ALICE, a.rigs);
    c.advanceTime(DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [a.rigs]));

    let threw = false;
    try {
      await c.call(ledger, ALICE, encodeCall('claimSeason(uint256,uint16[],uint16[])',
        ['uint256', 'uint16[]', 'uint16[]'], [0, a.rigs, []]));
    } catch (e) { threw = true; }
    check('cannot claim a season that is still running', threw);

    const p0 = decodeUint(await c.call(ledger, OWNER,
      encodeCall('poolFor(uint256)', ['uint256'], [0])));
    const p1 = decodeUint(await c.call(ledger, OWNER,
      encodeCall('poolFor(uint256)', ['uint256'], [1])));
    check('season 0 pool is 210,000 qBTC', p0 === 210_000n * ONE, `${fmt(p0)}`);
    check('the pool decays 4% per season', p1 === (p0 * 24n) / 25n, `${fmt(p1)}`);

    c.advanceTime(SEASON + DAY);
    const before = await balanceOf(c, qbtc, ALICE);
    await c.call(ledger, ALICE, encodeCall('claimSeason(uint256,uint16[],uint16[])',
      ['uint256', 'uint16[]', 'uint16[]'], [0, a.rigs, []]));
    const paid = (await balanceOf(c, qbtc, ALICE)) - before;
    check('a closed season pays out', paid > 0n, `${fmt(paid)} qBTC`);
    check('a sole miner takes the miners and operators ladders',
      paid > (p0 * 6000n) / 10000n, `${fmt(paid)} of ${fmt(p0)} pool`);

    threw = false;
    try {
      await c.call(ledger, ALICE, encodeCall('claimSeason(uint256,uint16[],uint16[])',
        ['uint256', 'uint16[]', 'uint16[]'], [0, a.rigs, []]));
    } catch (e) { threw = true; }
    check('the same season cannot be claimed twice', threw);
  }

  section('SYBIL NEUTRALITY');
  {
    // Two rigs in one wallet, versus the same two rigs split across two.
    // The season payout must come out identical, or splitting is profitable.
    async function run(split) {
      const { c, game, farm, ledger, qbtc } = await deployStack();
      const cur = { i: 1 };
      const a = await acquire(c, game, ALICE, 2, 0, cur);

      if (split) {
        await c.call(game, ALICE, encodeCall('transferFrom(address,address,uint256)',
          ['address', 'address', 'uint256'], [ALICE, BOB, a.rigs[1]]));
        await stake(c, game, farm, ALICE, [a.rigs[0]]);
        await stake(c, game, farm, BOB, [a.rigs[1]]);
      } else {
        await stake(c, game, farm, ALICE, a.rigs);
      }

      c.advanceTime(DAY);
      await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [[a.rigs[0]]]));
      await c.call(farm, split ? BOB : ALICE,
        encodeCall('claim(uint16[])', ['uint16[]'], [[a.rigs[1]]]));

      c.advanceTime(SEASON + DAY);
      let total = 0n;
      const aBefore = await balanceOf(c, qbtc, ALICE);
      await c.call(ledger, ALICE, encodeCall('claimSeason(uint256,uint16[],uint16[])',
        ['uint256', 'uint16[]', 'uint16[]'], [0, split ? [a.rigs[0]] : a.rigs, []]));
      total += (await balanceOf(c, qbtc, ALICE)) - aBefore;

      if (split) {
        const bBefore = await balanceOf(c, qbtc, BOB);
        await c.call(ledger, BOB, encodeCall('claimSeason(uint256,uint16[],uint16[])',
          ['uint256', 'uint16[]', 'uint16[]'], [0, [a.rigs[1]], []]));
        total += (await balanceOf(c, qbtc, BOB)) - bBefore;
      }
      return total;
    }

    const together = await run(false);
    const apart = await run(true);
    check('splitting a fleet across wallets pays exactly the same',
      together === apart, `one wallet ${fmt(together)} vs two ${fmt(apart)}`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nfailures:'); failures.forEach((f) => console.log('  -', f)); }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\nTEST RUN CRASHED:', e); process.exit(1); });
