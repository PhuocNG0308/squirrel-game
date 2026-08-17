/**
 * TraitStats, Fusion and Quests tests.
 *
 * The properties worth proving: that cosmetic traits now move real numbers,
 * that a fused rig is strictly better than either parent (otherwise nobody
 * would ever burn two tokens for one), and that quest gates cannot be cleared
 * without actually meeting them.
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

let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`); }
  else { failed++; failures.push(label); console.log(`  FAIL  ${label}  ${detail}`); }
}
const section = (n) => console.log(`\n=== ${n} ===`);
const fmt = (w) => (Number(w) / 1e18).toFixed(2);

async function deployStack() {
  const c = await Chain.create();
  for (const a of [OWNER, ALICE, BOB]) await c.fund(a, 10n ** 22n);

  const qbtc = await c.deploy('QBTC', [], [], OWNER);
  const traits = await c.deploy('Traits', ['string', 'string'], [BASE_URI, 'https://x'], OWNER);
  const game = await c.deploy('SquirrelGame', ['address', 'address', 'uint256'],
    [qbtc, traits, 50000], OWNER);
  const stats = await c.deploy('TraitStats', ['address'], [game], OWNER);
  const farm = await c.deploy('QuantumFarm', ['address', 'address'], [game, qbtc], OWNER);
  const post = await c.deploy('RaidPost', ['address', 'address'], [farm, qbtc], OWNER);
  const quests = await c.deploy('Quests', ['address', 'address'], [farm, qbtc], OWNER);
  const fusion = await c.deploy('Fusion', ['address', 'address', 'address'],
    [game, stats, qbtc], OWNER);

  await c.call(game, OWNER, encodeCall('setFarm(address)', ['address'], [farm]));
  await c.call(game, OWNER, encodeCall('setFusionForge(address)', ['address'], [fusion]));
  await c.call(traits, OWNER, encodeCall('setGame(address)', ['address'], [game]));
  await c.call(farm, OWNER, encodeCall('setRaidPost(address)', ['address'], [post]));
  await c.call(farm, OWNER, encodeCall('setStats(address)', ['address'], [stats]));
  await c.call(post, OWNER, encodeCall('setStats(address)', ['address'], [stats]));
  // forge fees and firewall points are charged against in-game credit first
  await c.call(farm, OWNER, encodeCall('setSpender(address,bool)',
    ['address', 'bool'], [fusion, true]));
  await c.call(farm, OWNER, encodeCall('setSpender(address,bool)',
    ['address', 'bool'], [post, true]));
  await c.call(fusion, OWNER, encodeCall('setFarm(address)', ['address'], [farm]));
  for (const ctrl of [farm, game, post, quests, fusion]) {
    await c.call(qbtc, OWNER, encodeCall('addController(address)', ['address'], [ctrl]));
  }
  return { c, qbtc, traits, game, stats, farm, post, quests, fusion };
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
  return {
    isQuantum: BigInt('0x' + w[0]) === 1n,
    chassis: Number(BigInt('0x' + w[1])), head: Number(BigInt('0x' + w[2])),
    ears: Number(BigInt('0x' + w[3])), eyes: Number(BigInt('0x' + w[4])),
    nose: Number(BigInt('0x' + w[5])), mouth: Number(BigInt('0x' + w[6])),
    neck: Number(BigInt('0x' + w[7])), feet: Number(BigInt('0x' + w[8])),
    tierIndex: Number(BigInt('0x' + w[9])),
  };
}

async function rigMods(c, stats, id) {
  const r = await c.call(stats, OWNER, encodeCall('rigMods(uint256)', ['uint256'], [id]));
  const w = r.replace(/^0x/, '').match(/.{64}/g) || [];
  return {
    hashrate: Number(BigInt('0x' + w[0])), decay: Number(BigInt('0x' + w[1])),
    coolant: Number(BigInt('0x' + w[2])), repair: Number(BigInt('0x' + w[3])),
  };
}

async function acquire(c, game, who, wantRigs, wantSquirrels, cursor) {
  const rigs = [], squirrels = [];
  for (let r = 0; r < 12 && (rigs.length < wantRigs || squirrels.length < wantSquirrels); r++) {
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

const creditOf = async (c, farm, who) =>
  decodeUint(await c.call(farm, OWNER, encodeCall('credit(address)', ['address'], [who])));

/**
 * Mines a staked rig so `who` has spendable in-game credit.
 *
 * Still runs nine days total, because callers below lean on the tenure for the
 * weekly quest — but there is no longer a vesting wait to sit out, so the nine
 * days are the quest's requirement rather than the token's.
 */
async function fund(c, farm, qbtc, who, rigIds) {
  c.advanceTime(DAY);
  await c.call(farm, who, encodeCall('claim(uint16[])', ['uint16[]'], [rigIds]));
  c.advanceTime(8 * DAY);
  return creditOf(c, farm, who);
}

/* ------------------------------------------------------------------ MAIN */

async function main() {
  section('TRAITS DRIVE REAL NUMBERS');
  {
    const { c, game, stats } = await deployStack();
    const cur = { i: 1 };
    const a = await acquire(c, game, ALICE, 6, 1, cur);

    let sawVariation = false;
    const seen = [];
    for (const id of a.rigs) {
      const m = await rigMods(c, stats, id);
      seen.push(m);
      // Every table spans both sides of NEUTRAL, so the bands do too: the
      // common roll in a slot is a genuine penalty, not a smaller bonus. The
      // bands are the exact table extremes — scripts/trait-balance.js is what
      // checks the shape in between.
      check(`rig #${id} mods are in a sane band`,
        m.hashrate >= 9400 && m.hashrate <= 12900
        && m.decay >= 8500 && m.decay <= 10900
        && m.coolant >= 6900 && m.coolant <= 10900
        && m.repair >= 8050 && m.repair <= 10500,
        `hash ${m.hashrate} decay ${m.decay} coolant ${m.coolant} repair ${m.repair}`);
    }
    for (let i = 1; i < seen.length; i++) {
      if (JSON.stringify(seen[i]) !== JSON.stringify(seen[0])) sawVariation = true;
    }
    check('different rolls produce different stats', sawVariation);

    if (a.squirrels.length) {
      const m = await rigMods(c, stats, a.squirrels[0]);
      check('a squirrel has neutral rig mods',
        m.hashrate === 10000 && m.decay === 10000, `hash ${m.hashrate}`);
    }
  }

  section('FUSION');
  {
    const { c, game, stats, farm, fusion, qbtc } = await deployStack();
    const cur = { i: 1 };
    const a = await acquire(c, game, ALICE, 3, 1, cur);
    check('found three rigs and a squirrel',
      a.rigs.length === 3 && a.squirrels.length === 1, `#${a.rigs.join(', #')}`);

    // one rig funds the forge fee; the other two are the feedstock
    await stake(c, game, farm, ALICE, [a.rigs[0]]);
    const funded = await fund(c, farm, qbtc, ALICE, [a.rigs[0]]);
    check('freshly mined yield can pay the forge fee', funded > 500n * ONE,
      `${fmt(funded)} qBTC of credit, fee 500`);

    let threw = false;
    try {
      await c.call(fusion, ALICE, encodeCall('fuse(uint256,uint256)',
        ['uint256', 'uint256'], [a.rigs[1], a.rigs[1]]));
    } catch (e) { threw = true; }
    check('cannot fuse a token with itself', threw);

    threw = false;
    try {
      await c.call(fusion, ALICE, encodeCall('fuse(uint256,uint256)',
        ['uint256', 'uint256'], [a.rigs[1], a.squirrels[0]]));
    } catch (e) { threw = true; }
    check('cannot fuse across species', threw);

    threw = false;
    try {
      await c.call(fusion, BOB, encodeCall('fuse(uint256,uint256)',
        ['uint256', 'uint256'], [a.rigs[1], a.rigs[2]]));
    } catch (e) { threw = true; }
    check('cannot fuse tokens you do not own', threw);

    const pa = await rigMods(c, stats, a.rigs[1]);
    const pb = await rigMods(c, stats, a.rigs[2]);
    const before = await creditOf(c, farm, ALICE);

    await c.call(fusion, ALICE, encodeCall('fuse(uint256,uint256)',
      ['uint256', 'uint256'], [a.rigs[1], a.rigs[2]]));

    const spent = before - (await creditOf(c, farm, ALICE));
    check('the forge fee comes out of credit', spent === 500n * ONE, `${fmt(spent)} qBTC`);
    check('and never touched the wallet', (await balanceOf(c, qbtc, ALICE)) === 0n);

    const forged = Number(decodeUint(await c.call(game, OWNER, encodeCall('forged()', [], []))));
    const childId = 50000 + forged;
    check('the child is numbered above the mint supply', forged === 1, `#${childId}`);

    const owner = decodeAddress(await c.call(game, OWNER,
      encodeCall('ownerOf(uint256)', ['uint256'], [childId])));
    check('the child belongs to the forger', owner === ALICE.toLowerCase());

    const gen = decodeUint(await c.call(game, OWNER,
      encodeCall('generationOf(uint256)', ['uint256'], [childId])));
    check('the child is generation 1', gen === 1n);

    for (const parent of [a.rigs[1], a.rigs[2]]) {
      let burned = false;
      try {
        await c.call(game, OWNER, encodeCall('ownerOf(uint256)', ['uint256'], [parent]));
      } catch (e) { burned = true; }
      check(`parent #${parent} was burned`, burned);
    }

    const child = await rigMods(c, stats, childId);
    check('the child never mines worse than either parent',
      child.hashrate >= pa.hashrate && child.hashrate >= pb.hashrate,
      `${pa.hashrate} / ${pb.hashrate} -> ${child.hashrate}`);
    check('the child never wears faster than either parent',
      child.decay <= pa.decay && child.decay <= pb.decay,
      `${pa.decay} / ${pb.decay} -> ${child.decay}`);
    check('the child inherits the cheaper coolant',
      child.coolant <= pa.coolant && child.coolant <= pb.coolant,
      `${pa.coolant} / ${pb.coolant} -> ${child.coolant}`);
    check('the child inherits the cheaper repairs',
      child.repair <= pa.repair && child.repair <= pb.repair,
      `${pa.repair} / ${pb.repair} -> ${child.repair}`);
    check('the generation bonus is applied on top',
      child.hashrate >= Math.max(pa.hashrate, pb.hashrate) * 1.05,
      `+${((child.hashrate / Math.max(pa.hashrate, pb.hashrate) - 1) * 100).toFixed(1)}%`);

    threw = false;
    try {
      await c.call(fusion, ALICE, encodeCall('fuse(uint256,uint256)',
        ['uint256', 'uint256'], [childId, a.rigs[0]]));
    } catch (e) { threw = true; }
    check('cannot fuse across generations', threw);
  }

  section('STARTER PACK');
  {
    const { c, game, farm, fusion, stats } = await deployStack();
    const price = decodeUint(await c.call(game, OWNER, encodeCall('MINT_PRICE()', [], [])));
    const pack = price * 3n;

    let threw = false;
    try {
      await c.call(game, ALICE, encodeCall('startGame()', [], []), price);
    } catch (e) { threw = true; }
    check('the pack costs exactly three mints', threw);

    await c.call(game, ALICE, encodeCall('startGame()', [], []), pack);
    const minted = decodeUint(await c.call(game, OWNER, encodeCall('minted()', [], [])));
    check('one signature mints three rigs, with no reveal', minted === 3n, `${minted} tokens`);

    const k = Number(decodeUint(await c.call(game, OWNER,
      encodeCall('STARTER_TRAIT_INDEX()', [], []))));
    for (let id = 1; id <= 3; id++) {
      const t = await traitsOf(c, game, id);
      check(`starter token #${id} is a rig at the neutral index`,
        t.isQuantum && t.chassis === k && t.head === k && t.nose === k && t.feet === k,
        `chassis ${t.chassis} head ${t.head} nose ${t.nose} feet ${t.feet}`);

      /**
       * The one that matters. A pack bought with real QRL must be the
       * reference machine, not the worst machine: index 0 carries the penalty
       * side of every table, so a loadout built from it would be strictly the
       * worst rig in the collection — and the guided fusion could not repair
       * it, since `_combine` takes the better of each slot and both parents
       * are identical.
       */
      const m = await rigMods(c, stats, id);
      check(`starter token #${id} is exactly neutral on all four stats`,
        m.hashrate === 10000 && m.decay === 10000
        && m.coolant === 10000 && m.repair === 10000,
        `hash ${m.hashrate} wear ${m.decay} coolant ${m.coolant} repair ${m.repair}`);

      const owner = decodeAddress(await c.call(game, OWNER,
        encodeCall('ownerOf(uint256)', ['uint256'], [id])));
      check(`starter token #${id} belongs to the player`, owner === ALICE.toLowerCase());
    }

    threw = false;
    try { await c.call(game, ALICE, encodeCall('startGame()', [], []), pack); }
    catch (e) { threw = true; }
    check('one pack per address', threw);

    // the voucher is opened but pays nothing until the player makes progress
    const starter = async () => decodeUint(await c.call(farm, OWNER,
      encodeCall('starterCredit(address)', ['address'], [ALICE])));
    check('the voucher starts empty', (await starter()) === 0n);

    await stake(c, game, farm, ALICE, [3]);
    check('200 qBTC unlocks on the first stake', (await starter()) === 200n * ONE,
      `${fmt(await starter())} qBTC`);

    c.advanceTime(DAY);
    await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [[3]]));
    check('300 more unlocks on the first claim', (await starter()) === 500n * ONE,
      `${fmt(await starter())} qBTC`);

    // and it is a voucher: spent before credit, and never withdrawable
    const voucherBefore = await starter();
    const creditBefore = await creditOf(c, farm, ALICE);
    await c.call(farm, ALICE, encodeCall('refuel(uint16[],uint256)',
      ['uint16[]', 'uint256'], [[3], DAY]));
    const fromVoucher = voucherBefore - (await starter());
    const fromCredit = creditBefore - (await creditOf(c, farm, ALICE));
    check('upkeep drains the voucher before it touches earned credit',
      fromCredit === 0n || (await starter()) === 0n,
      `${fmt(fromVoucher)} voucher + ${fmt(fromCredit)} credit`);

    // the withdrawal cap is a share of `credit` alone, so a farmed voucher can
    // never be turned into a transferable token
    let leaked = false;
    try {
      await c.call(farm, ALICE, encodeCall('requestWithdraw(uint256)',
        ['uint256'], [(creditBefore / 4n) + (500n * ONE)]));
      leaked = true;
    } catch (e) { /* expected */ }
    check('the voucher does not raise what can be withdrawn', !leaked);

    section('GUIDED FUSION');

    threw = false;
    try {
      await c.call(fusion, ALICE, encodeCall('starterFuse(uint16,uint16)',
        ['uint16', 'uint16'], [1, 3]));
    } catch (e) { threw = true; }
    check('cannot feed a staked rig to the guided fusion', threw);

    // Without these two gates the guided fusion is a free `fuse()`, and since
    // addresses are free a large holder would route every fusion through a
    // fresh wallet.
    threw = false;
    try {
      await c.call(fusion, BOB, encodeCall('starterFuse(uint16,uint16)',
        ['uint16', 'uint16'], [1, 2]));
    } catch (e) { threw = true; }
    check('an address that never bought a pack cannot use it', threw);

    // Bob buys a pack of his own, then tries to walk in a rolled rig
    await c.call(game, BOB, encodeCall('startGame()', [], []), pack);
    const rolled = await acquire(c, game, BOB, 1, 0, { i: 7 });
    threw = false;
    try {
      await c.call(fusion, BOB, encodeCall('starterFuse(uint16,uint16)',
        ['uint16', 'uint16'], [4, rolled.rigs[0]]));
    } catch (e) { threw = true; }
    check('and a bought pack cannot launder a rolled rig through it', threw,
      `tried #4 with rolled #${rolled.rigs[0]}`);

    const bps = decodeUint(await c.call(fusion, OWNER,
      encodeCall('STARTER_FUSE_SQUIRREL_BPS()', [], [])));
    const tier = decodeUint(await c.call(fusion, OWNER,
      encodeCall('STARTER_FUSE_TIER_INDEX()', [], [])));
    check('the odds are public, so the screen can state them before signing',
      bps === 4000n && tier === 2n, `${Number(bps) / 100}% squirrel, tierIndex ${tier}`);

    await c.call(fusion, ALICE, encodeCall('starterFuse(uint16,uint16)',
      ['uint16', 'uint16'], [1, 2]));

    for (const parent of [1, 2]) {
      let burned = false;
      try { await c.call(game, OWNER, encodeCall('ownerOf(uint256)', ['uint256'], [parent])); }
      catch (e) { burned = true; }
      check(`parent #${parent} is burned at commit, not at reveal`, burned);
    }

    threw = false;
    try { await c.call(fusion, ALICE, encodeCall('settleStarterFuse()', [], [])); }
    catch (e) { threw = true; }
    check('cannot settle in the commit block', threw);

    c.advance(2);
    await c.call(fusion, BOB, encodeCall('settleStarterFuse(address)', ['address'], [ALICE]));

    const forged = Number(decodeUint(await c.call(game, OWNER, encodeCall('forged()', [], []))));
    const childId = 50000 + forged;
    const child = await traitsOf(c, game, childId);
    const owner = decodeAddress(await c.call(game, OWNER,
      encodeCall('ownerOf(uint256)', ['uint256'], [childId])));
    check('anyone may settle, and the token goes to the player',
      forged === 1 && owner === ALICE.toLowerCase(), `#${childId}`);
    check('a rolled squirrel comes in at the baseline rank',
      child.isQuantum || child.tierIndex === 2,
      child.isQuantum ? 'rolled a rig' : `rolled a squirrel, tierIndex ${child.tierIndex}`);

    const gen = decodeUint(await c.call(game, OWNER,
      encodeCall('generationOf(uint256)', ['uint256'], [childId])));
    check('the guided fusion still advances a generation', gen === 1n);

    const stillMining = decodeAddress(await c.call(farm, OWNER,
      encodeCall('rigOwner(uint16)', ['uint16'], [3])));
    check('the third rig kept mining throughout', stillMining === ALICE.toLowerCase());

    threw = false;
    try {
      await c.call(fusion, ALICE, encodeCall('starterFuse(uint16,uint16)',
        ['uint16', 'uint16'], [childId, 3]));
    } catch (e) { threw = true; }
    check('the guided fusion is once per address', threw);
  }

  section('QUESTS: DAILY');
  {
    const { c, game, farm, quests, qbtc } = await deployStack();
    const cur = { i: 1 };
    const a = await acquire(c, game, ALICE, 2, 0, cur);
    await stake(c, game, farm, ALICE, a.rigs);

    const day0 = Number(decodeUint(await c.call(quests, OWNER, encodeCall('today()', [], []))));
    await c.call(quests, ALICE, encodeCall('clearDaily(uint16[])', ['uint16[]'], [a.rigs]));

    let early = false;
    try { await c.call(quests, ALICE, encodeCall('claimDaily(uint256)', ['uint256'], [day0])); }
    catch (e) { early = true; }
    check('a day cannot be settled while it is still running', early);

    c.advanceTime(DAY);
    await c.call(quests, ALICE, encodeCall('claimDaily(uint256)', ['uint256'], [day0]));
    const v = await c.call(quests, OWNER, encodeCall('vestingOf(address)', ['address'], [ALICE]));
    const amount = BigInt('0x' + v.replace(/^0x/, '').match(/.{64}/g)[0]);
    check('a closed day pays the qualified fleet', amount > 0n, `${fmt(amount)} qBTC vesting`);

    let threw = false;
    try {
      await c.call(quests, ALICE, encodeCall('clearDaily(uint16[])', ['uint16[]'], [a.rigs]));
    } catch (e) { threw = true; }
    check('the daily cannot be cleared twice in one day', threw);

    threw = false;
    try {
      await c.call(quests, BOB, encodeCall('clearDaily(uint16[])', ['uint16[]'], [a.rigs]));
    } catch (e) { threw = true; }
    check('cannot clear the daily on someone else\'s rigs', threw);

    // let the coolant lapse; the rig is no longer in good order
    c.advanceTime(3 * DAY);
    threw = false;
    try {
      await c.call(quests, ALICE, encodeCall('clearDaily(uint16[])', ['uint16[]'], [a.rigs]));
    } catch (e) { threw = true; }
    check('an unfuelled rig fails the daily', threw);
  }

  section('QUESTS: WEEKLY & MILESTONES');
  {
    const { c, game, farm, quests, qbtc } = await deployStack();
    const cur = { i: 1 };
    const a = await acquire(c, game, ALICE, 1, 0, cur);
    await stake(c, game, farm, ALICE, a.rigs);

    let threw = false;
    try {
      await c.call(quests, ALICE, encodeCall('clearWeekly(uint16[])', ['uint16[]'], [a.rigs]));
    } catch (e) { threw = true; }
    check('the weekly needs seven days staked', threw);

    threw = false;
    try {
      await c.call(quests, ALICE, encodeCall('claimMilestone(uint16,uint8)',
        ['uint16', 'uint8'], [a.rigs[0], 0]));
    } catch (e) { threw = true; }
    check('the 30-day milestone needs tenure', threw);

    await fund(c, farm, qbtc, ALICE, a.rigs);           // 9 days staked
    await c.call(farm, ALICE, encodeCall('refuel(uint16[],uint256)',
      ['uint16[]', 'uint256'], [a.rigs, 7 * DAY]));

    await c.call(quests, ALICE, encodeCall('clearWeekly(uint16[])', ['uint16[]'], [a.rigs]));
    check('a rig staked a week and running clears the weekly', true);

    threw = false;
    try {
      await c.call(quests, ALICE, encodeCall('clearWeekly(uint16[])', ['uint16[]'], [a.rigs]));
    } catch (e) { threw = true; }
    check('the weekly cannot be cleared twice in one week', threw);

    c.advanceTime(30 * DAY);
    await c.call(quests, ALICE, encodeCall('claimMilestone(uint16,uint8)',
      ['uint16', 'uint8'], [a.rigs[0], 0]));
    check('the 30-day milestone pays once tenured', true);

    threw = false;
    try {
      await c.call(quests, ALICE, encodeCall('claimMilestone(uint16,uint8)',
        ['uint16', 'uint8'], [a.rigs[0], 0]));
    } catch (e) { threw = true; }
    check('a milestone cannot be claimed twice', threw);

    threw = false;
    try {
      await c.call(quests, ALICE, encodeCall('claimMilestone(uint16,uint8)',
        ['uint16', 'uint8'], [a.rigs[0], 1]));
    } catch (e) { threw = true; }
    check('the 60-day milestone is still locked', threw);
  }

  section('QUESTS: 14-DAY VESTING');
  {
    const { c, game, farm, quests, qbtc } = await deployStack();
    const cur = { i: 1 };
    const a = await acquire(c, game, ALICE, 1, 0, cur);
    await stake(c, game, farm, ALICE, a.rigs);
    const d0 = Number(decodeUint(await c.call(quests, OWNER, encodeCall('today()', [], []))));
    await c.call(quests, ALICE, encodeCall('clearDaily(uint16[])', ['uint16[]'], [a.rigs]));
    c.advanceTime(DAY);
    await c.call(quests, ALICE, encodeCall('claimDaily(uint256)', ['uint256'], [d0]));

    const v0 = await c.call(quests, OWNER, encodeCall('vestingOf(address)', ['address'], [ALICE]));
    const w0 = v0.replace(/^0x/, '').match(/.{64}/g);
    const total = BigInt('0x' + w0[0]);
    check('nothing is releasable immediately', BigInt('0x' + w0[1]) === 0n);

    c.advanceTime(7 * DAY);
    const v7 = await c.call(quests, OWNER, encodeCall('vestingOf(address)', ['address'], [ALICE]));
    const rel7 = BigInt('0x' + v7.replace(/^0x/, '').match(/.{64}/g)[1]);
    check('about half releasable at seven days', rel7 > (total * 45n) / 100n && rel7 < (total * 55n) / 100n,
      `${fmt(rel7)} of ${fmt(total)}`);

    c.advanceTime(8 * DAY);
    const before = await balanceOf(c, qbtc, ALICE);
    await c.call(quests, ALICE, encodeCall('withdraw()', [], []));
    const got = (await balanceOf(c, qbtc, ALICE)) - before;
    check('the full amount pays out after fourteen days', got === total, `${fmt(got)} qBTC`);
  }

  section('QUESTS: THE BUDGET HOLDS');
  {
    // Paying each claimant as they arrive would give the first player the
    // whole day's budget and the second half of it again. Two players sharing
    // a day must together receive at most one budget.
    const { c, game, farm, quests } = await deployStack();
    const cur = { i: 1 };
    const a = await acquire(c, game, ALICE, 1, 0, cur);
    const b = await acquire(c, game, BOB, 3, 0, cur);
    await stake(c, game, farm, ALICE, a.rigs);
    await stake(c, game, farm, BOB, b.rigs);

    const day = Number(decodeUint(await c.call(quests, OWNER, encodeCall('today()', [], []))));
    await c.call(quests, ALICE, encodeCall('clearDaily(uint16[])', ['uint16[]'], [a.rigs]));
    await c.call(quests, BOB, encodeCall('clearDaily(uint16[])', ['uint16[]'], [b.rigs]));

    c.advanceTime(DAY);
    await c.call(quests, ALICE, encodeCall('claimDaily(uint256)', ['uint256'], [day]));
    await c.call(quests, BOB, encodeCall('claimDaily(uint256)', ['uint256'], [day]));

    const av = await c.call(quests, OWNER, encodeCall('vestingOf(address)', ['address'], [ALICE]));
    const bv = await c.call(quests, OWNER, encodeCall('vestingOf(address)', ['address'], [BOB]));
    const aAmt = BigInt('0x' + av.replace(/^0x/, '').match(/.{64}/g)[0]);
    const bAmt = BigInt('0x' + bv.replace(/^0x/, '').match(/.{64}/g)[0]);
    const budget = decodeUint(await c.call(quests, OWNER,
      encodeCall('DAILY_BUDGET()', [], [])));

    check('two players never exceed one day of budget', aAmt + bAmt <= budget,
      `${fmt(aAmt)} + ${fmt(bAmt)} vs budget ${fmt(budget)}`);
    check('the split follows the rig count 1:3',
      bAmt === aAmt * 3n, `${fmt(aAmt)} vs ${fmt(bAmt)}`);

    let threw = false;
    try { await c.call(quests, ALICE, encodeCall('claimDaily(uint256)', ['uint256'], [day])); }
    catch (e) { threw = true; }
    check('a day cannot be settled twice', threw);

    const awarded = decodeUint(await c.call(quests, OWNER,
      encodeCall('totalAwarded()', [], [])));
    check('the running total matches what was handed out', awarded === aAmt + bAmt,
      `${fmt(awarded)} qBTC`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nfailures:'); failures.forEach((f) => console.log('  -', f)); }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\nTEST RUN CRASHED:', e); process.exit(1); });
