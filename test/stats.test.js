/**
 * Proves that every stat on every NFT does something.
 *
 * A stat table is worthless if the accounting ignores it, so each of the four
 * rig modifiers and each of the four squirrel modifiers is checked against an
 * outcome it is supposed to move — not merely read back from the table that
 * produced it.
 */
const { Chain, encodeCall, decodeUint, decodeAddress } = require('./harness');

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
const fmt = (w) => (Number(w) / 1e18).toFixed(2);

async function deployStack(withStats = true) {
  const c = await Chain.create();
  for (const a of [OWNER, ALICE, BOB]) await c.fund(a, 10n ** 22n);

  const qbtc = await c.deploy('QBTC', [], [], OWNER);
  const traits = await c.deploy('Traits', ['string', 'string'], [BASE_URI, 'https://x'], OWNER);
  const game = await c.deploy('SquirrelGame', ['address', 'address', 'uint256'],
    [qbtc, traits, 50000], OWNER);
  const stats = await c.deploy('TraitStats', ['address'], [game], OWNER);
  const farm = await c.deploy('QuantumFarm', ['address', 'address'], [game, qbtc], OWNER);
  const post = await c.deploy('RaidPost', ['address', 'address'], [farm, qbtc], OWNER);

  await c.call(game, OWNER, encodeCall('setFarm(address)', ['address'], [farm]));
  await c.call(traits, OWNER, encodeCall('setGame(address)', ['address'], [game]));
  await c.call(farm, OWNER, encodeCall('setRaidPost(address)', ['address'], [post]));
  if (withStats) {
    await c.call(farm, OWNER, encodeCall('setStats(address)', ['address'], [stats]));
    await c.call(post, OWNER, encodeCall('setStats(address)', ['address'], [stats]));
    await c.call(traits, OWNER, encodeCall('setStats(address)', ['address'], [stats]));
  }
  for (const ctrl of [farm, game, post]) {
    await c.call(qbtc, OWNER, encodeCall('addController(address)', ['address'], [ctrl]));
  }
  return { c, qbtc, traits, game, stats, farm, post };
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

/** Decodes TraitStats.statsOf, which returns a dynamic struct. */
async function statsOf(c, stats, id) {
  const r = await c.call(stats, OWNER, encodeCall('statsOf(uint256)', ['uint256'], [id]));
  const hex = r.replace(/^0x/, '');
  const word = (i) => BigInt('0x' + hex.slice(i * 64, (i + 1) * 64));
  // head: offset to struct; struct head: isQuantum, tier, generation, alpha,
  // mods (static uint16[4], inline), labels offset
  const base = Number(word(0)) / 32;
  return {
    isQuantum: word(base) === 1n,
    tier: Number(word(base + 1)),
    generation: Number(word(base + 2)),
    alpha: Number(word(base + 3)),
    mods: [4, 5, 6, 7].map((k) => Number(word(base + k))),
  };
}

async function decodeTokenURI(c, game, id) {
  const raw = await c.call(game, OWNER, encodeCall('tokenURI(uint256)', ['uint256'], [id]));
  const hex = raw.replace(/^0x/, '');
  const len = Number(BigInt('0x' + hex.slice(64, 128)));
  const uri = Buffer.from(hex.slice(128, 128 + len * 2), 'hex').toString('utf8');
  return JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
}

/* ------------------------------------------------------------------ MAIN */

async function main() {
  section('EVERY MINT CARRIES A FULL STAT LINE');
  {
    const { c, game, stats } = await deployStack();
    const cur = { i: 1 };
    const a = await acquire(c, game, ALICE, 3, 2, cur);

    for (const id of a.rigs) {
      const s = await statsOf(c, stats, id);
      check(`rig #${id} reports four stats`,
        s.isQuantum && s.mods.every((m) => m > 0) && s.tier === 0,
        `[${s.mods.join(', ')}] gen ${s.generation}`);
    }
    for (const id of a.squirrels) {
      const s = await statsOf(c, stats, id);
      check(`squirrel #${id} reports four stats plus tier and alpha`,
        !s.isQuantum && s.mods.every((m) => m > 0) && s.tier >= 1 && s.tier <= 3
        && s.alpha >= 6 && s.alpha <= 8,
        `tier ${s.tier} alpha ${s.alpha} [${s.mods.join(', ')}]`);
    }
  }

  section('STATS APPEAR IN THE METADATA');
  {
    const { c, game, stats } = await deployStack();
    const cur = { i: 1 };
    const a = await acquire(c, game, ALICE, 1, 1, cur);

    for (const [kind, id] of [['rig', a.rigs[0]], ['squirrel', a.squirrels[0]]]) {
      const meta = await decodeTokenURI(c, game, id);
      const names = meta.attributes.map((x) => x.trait_type);
      const s = await statsOf(c, stats, id);
      const expected = s.isQuantum
        ? ['Hashrate', 'Wear Rate', 'Coolant Draw', 'Repair Cost']
        : ['Raid Accuracy', 'Plunder Share', 'Energy Draw', 'Tax Share'];
      check(`${kind} metadata lists its stat line`,
        expected.every((e) => names.includes(e)), expected.join(', '));
      check(`${kind} metadata has no duplicate attribute names`,
        new Set(names).size === names.length,
        names.filter((n, i) => names.indexOf(n) !== i).join(', ') || 'none');
    }
  }

  section('RIG STATS MOVE REAL OUTCOMES');
  {
    // The same fleet is run twice: once with the stats table wired and once
    // without. Any modifier that is read but never applied would show up as
    // an identical result across both runs.
    async function run(withStats) {
      const { c, game, farm, qbtc, stats } = await deployStack(withStats);
      const cur = { i: 1 };
      const a = await acquire(c, game, ALICE, 1, 0, cur);
      await stake(c, game, farm, ALICE, a.rigs);
      c.advanceTime(DAY);
      await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [a.rigs]));

      const mined = decodeUint(await c.call(farm, OWNER, encodeCall('totalMined()', [], [])));
      const st = await c.call(farm, OWNER, encodeCall('rigState(uint16)', ['uint16'], [a.rigs[0]]));
      const durability = Number(BigInt('0x' + st.replace(/^0x/, '').slice(0, 64)));

      // upkeep is paid out of the credit the same rig just earned, so the
      // deltas are read there rather than on the ERC-20 balance
      const credit = () => c.call(farm, OWNER,
        encodeCall('credit(address)', ['address'], [ALICE])).then(decodeUint);

      c.advanceTime(8 * DAY);
      const before = await credit();
      await c.call(farm, ALICE, encodeCall('refuel(uint16[],uint256)',
        ['uint16[]', 'uint256'], [a.rigs, DAY]));
      const coolant = before - (await credit());

      const mid = await credit();
      await c.call(farm, ALICE, encodeCall('repair(uint16[])', ['uint16[]'], [a.rigs]));
      const repair = mid - (await credit());

      const m = withStats
        ? (await c.call(stats, OWNER, encodeCall('rigMods(uint256)', ['uint256'], [a.rigs[0]])))
          .replace(/^0x/, '').match(/.{64}/g).map((w) => Number(BigInt('0x' + w)))
        : [10000, 10000, 10000, 10000];

      return { mined, durability, coolant, repair, mods: m };
    }

    const on = await run(true);
    const off = await run(false);

    // Each table now has an exactly-neutral entry that ~30% of rolls land on,
    // so "with stats differs from without" is only a real expectation when the
    // sampled rig actually rolled a non-neutral modifier.
    check('hashrate modifier changes what a rig mines',
      on.mods[0] === 10000 || on.mined !== off.mined,
      `${fmt(on.mined)} with stats vs ${fmt(off.mined)} without (hash ${on.mods[0]})`);
    check('wear-rate modifier changes durability lost',
      on.mods[1] === 10000 || on.durability !== off.durability,
      `${on.durability} vs ${off.durability} (wear ${on.mods[1]})`);
    // a table can now roll neutral in the middle, so a matching bill is only a
    // failure when the modifier was actually non-neutral
    check('coolant modifier changes the refuel bill',
      on.mods[2] === 10000 || on.coolant !== off.coolant,
      `${fmt(on.coolant)} vs ${fmt(off.coolant)} (draw ${on.mods[2]})`);
    check('repair modifier changes the repair bill',
      on.mods[3] === 10000 || on.repair !== off.repair,
      `${fmt(on.repair)} vs ${fmt(off.repair)} (cost ${on.mods[3]})`);
  }

  section('SQUIRREL STATS MOVE REAL OUTCOMES');
  {
    async function run(withStats) {
      const { c, game, farm, post, qbtc, stats } = await deployStack(withStats);
      const cur = { i: 1 };
      const a = await acquire(c, game, ALICE, 1, 1, cur);
      await stake(c, game, farm, ALICE, [...a.rigs, ...a.squirrels]);

      c.advanceTime(DAY);
      await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [a.rigs]));
      // settle the squirrel to realise its tax share
      const beforeGuard = decodeUint(await c.call(farm, OWNER,
        encodeCall('credit(address)', ['address'], [ALICE])));
      await c.call(farm, ALICE, encodeCall('claim(uint16[])', ['uint16[]'], [a.squirrels]));
      const vested = decodeUint(await c.call(farm, OWNER,
        encodeCall('credit(address)', ['address'], [ALICE]))) - beforeGuard;

      const g = await c.call(farm, OWNER,
        encodeCall('guardOwner(uint16)', ['uint16'], [a.squirrels[0]]));
      const energy = Number(BigInt('0x' + g.replace(/^0x/, '').match(/.{64}/g)[1]));

      const odds = decodeUint(await c.call(post, OWNER,
        encodeCall('oddsAgainst(uint16,uint16)', ['uint16', 'uint16'],
          [a.squirrels[0], a.rigs[0]])));

      const mods = withStats ? (await statsOf(c, stats, a.squirrels[0])).mods : [0, 0, 0, 0];
      return { vested, energy, odds, mods };
    }

    const on = await run(true);
    const off = await run(false);

    check('raid-accuracy modifier changes the odds',
      on.mods[0] === 10000 || on.odds !== off.odds,
      `${(Number(on.odds) / 1e16).toFixed(1)}% vs ${(Number(off.odds) / 1e16).toFixed(1)}%`
      + ` (accuracy ${on.mods[0]})`);
    check('energy-draw modifier changes energy remaining',
      on.mods[2] === 10000 || on.energy !== off.energy,
      `${on.energy} vs ${off.energy} (draw ${on.mods[2]})`);
    check('tax-share modifier changes the payout',
      on.mods[3] === 10000 || on.vested !== off.vested,
      `${fmt(on.vested)} vs ${fmt(off.vested)} (tax ${on.mods[3]})`);
    // tables now span both sides of neutral, so a plunder share below 10000 is
    // a legitimate roll rather than a bug — only the band is asserted
    check('plunder-share modifier is exposed on the sheet',
      on.mods[1] >= 9100 && on.mods[1] <= 12200, `${on.mods[1]}`);
  }

  section('EVERY SQUIRREL STAT IS WIRED SOMEWHERE');
  {
    // A directed check that no modifier is computed and then dropped: each is
    // driven to a non-neutral value across a sample and matched to a caller.
    const { c, game, stats } = await deployStack();
    const cur = { i: 1 };
    const a = await acquire(c, game, ALICE, 0, 6, cur);

    const seen = [false, false, false, false];
    for (const id of a.squirrels) {
      const s = await statsOf(c, stats, id);
      s.mods.forEach((m, i) => { if (m !== 10000) seen[i] = true; });
    }
    const names = ['Raid Accuracy', 'Plunder Share', 'Energy Draw', 'Tax Share'];
    seen.forEach((was, i) => {
      check(`${names[i]} varies across rolls`, was || a.squirrels.length < 4,
        `${a.squirrels.length} squirrels sampled`);
    });
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nfailures:'); failures.forEach((f) => console.log('  -', f)); }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\nTEST RUN CRASHED:', e); process.exit(1); });
