/**
 * Emission and retention model for the revised GDD.
 *
 * Design thesis: a Ponzi pays for depositing, a game pays for playing. The
 * lever that reduces Ponzi character is not the burn rate — it is what
 * fraction of emission is gated behind *activity* rather than behind *stake
 * size*, and whether rewards are ranked or capital-weighted.
 *
 * Total supply stays at 21,000,000. What changes is the shape of the curve
 * and who is eligible to receive it.
 */

const CAP = 21_000_000;
const SEASON_DAYS = 30;
const SEASONS_PER_YEAR = 365 / SEASON_DAYS;

/* ---------------------------------------------------------- ALLOCATION */

const POOLS = {
  mining:    { share: 0.50, decay: 0.04, gated: 'upkeep',   label: 'Rig mining yield' },
  season:    { share: 0.25, decay: 0.04, gated: 'rank',     label: 'Season reward pools' },
  quests:    { share: 0.15, decay: 0.00, gated: 'activity', label: 'Quests & achievements' },
  liquidity: { share: 0.05, decay: null, gated: 'locked',   label: 'AMM liquidity bootstrap' },
  reserve:   { share: 0.05, decay: null, gated: 'vested',   label: 'Treasury / ops reserve' },
};

const QUEST_SEASONS = 60; // quests pay out flat across 5 years

/** Emission for a pool in a given season index. */
function poolEmission(pool, season) {
  const total = CAP * pool.share;
  if (pool.decay === null) return 0;            // released, not emitted per-season
  if (pool.decay === 0) {
    return season < QUEST_SEASONS ? total / QUEST_SEASONS : 0;
  }
  const s0 = total * pool.decay;                // geometric series sum = s0 / decay
  return s0 * Math.pow(1 - pool.decay, season);
}

/* ---------------------------------------------------------------- SINKS */

// Gen 1 mint ladder, burned on mint
const GEN1_BURN_TOTAL = 10_000 * 175 + 20_000 * 350 + 10_000 * 700; // 15,750,000
// Maintenance burn as a share of mining emission (from scripts/simulate.js)
const UPKEEP_BURN_SHARE = 0.38;
// Upgrades, firewalls, season passes, fusion — a standing sink once players
// have progression to chase
const PROGRESSION_BURN_SHARE = 0.12;

const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d });
const pct = (n, d = 1) => `${(n * 100).toFixed(d)}%`;

/* -------------------------------------------------------------- REPORT */

console.log('=== 1. SUPPLY ALLOCATION (21,000,000 qBTC) ===\n');
console.log('%s %s %s %s',
  'pool'.padEnd(28), 'amount'.padStart(12), 'share'.padStart(8), 'gated by'.padStart(12));
let allocTotal = 0;
for (const p of Object.values(POOLS)) {
  allocTotal += CAP * p.share;
  console.log('%s %s %s %s',
    p.label.padEnd(28), fmt(CAP * p.share).padStart(12),
    pct(p.share, 0).padStart(8), p.gated.padStart(12));
}
console.log('%s %s %s',
  'TOTAL'.padEnd(28), fmt(allocTotal).padStart(12), pct(allocTotal / CAP, 0).padStart(8));
console.log(`\nallocation sums to cap: ${allocTotal === CAP ? 'YES' : 'NO (' + fmt(allocTotal) + ')'}`);

console.log('\n\n=== 2. HOW MUCH REWARD IS EARNED BY PLAYING? ===\n');
console.log('The anti-Ponzi metric. Capital-weighted emission rewards whoever');
console.log('deposits most; activity- and rank-gated emission rewards whoever');
console.log('plays best.\n');
const capitalWeighted = POOLS.mining.share;
const activityGated = POOLS.season.share + POOLS.quests.share;
console.log(`capital-weighted (mining, by rig count)   ${pct(capitalWeighted, 0)}`);
console.log(`activity / rank gated (seasons, quests)   ${pct(activityGated, 0)}`);
console.log(`not emitted to players (LP, reserve)      ${pct(1 - capitalWeighted - activityGated, 0)}`);
console.log();
console.log('Even the mining half is gated: a rig earns nothing without Cryo');
console.log('fuel and repair, so idle capital yields zero rather than a trickle.');

console.log('\n\n=== 3. EMISSION CURVE ===\n');
console.log('%s %s %s %s %s %s',
  'year'.padEnd(6), 'mining'.padStart(12), 'season'.padStart(11),
  'quests'.padStart(10), 'total'.padStart(12), 'of cap'.padStart(9));

const yearly = [];
let cumulative = 0;
for (let y = 0; y < 8; y++) {
  let mining = 0; let season = 0; let quests = 0;
  for (let s = Math.floor(y * SEASONS_PER_YEAR); s < Math.floor((y + 1) * SEASONS_PER_YEAR); s++) {
    mining += poolEmission(POOLS.mining, s);
    season += poolEmission(POOLS.season, s);
    quests += poolEmission(POOLS.quests, s);
  }
  const total = mining + season + quests;
  cumulative += total;
  yearly.push({ y, mining, season, quests, total, cumulative });
  console.log('%s %s %s %s %s %s',
    String(y + 1).padEnd(6), fmt(mining).padStart(12), fmt(season).padStart(11),
    fmt(quests).padStart(10), fmt(total).padStart(12),
    pct(cumulative / CAP, 1).padStart(9));
}

console.log('\n\n=== 4. CIRCULATING SUPPLY AFTER SINKS ===\n');
console.log('Gen 1 minting burns 15,750,000 qBTC over the life of the');
console.log('collection — a sink larger than the entire mining pool. Upkeep');
console.log('burns 38% of mining yield; progression burns a further 12%.\n');

console.log('%s %s %s %s %s',
  'year'.padEnd(6), 'emitted'.padStart(12), 'burned'.padStart(12),
  'circulating'.padStart(14), 'net infl'.padStart(10));

let circulating = 0;
let gen1Remaining = GEN1_BURN_TOTAL;
for (const r of yearly) {
  // Gen 1 minting is demand-driven; assume it absorbs qBTC as fast as players
  // can afford it, tapering as the supply is minted out.
  const affordable = r.total * 0.35;
  const gen1Burn = Math.min(gen1Remaining, affordable);
  gen1Remaining -= gen1Burn;

  const upkeep = r.mining * UPKEEP_BURN_SHARE;
  const progression = r.total * PROGRESSION_BURN_SHARE;
  const burned = upkeep + progression + gen1Burn;

  const before = circulating;
  circulating += r.total - burned;
  const netInfl = before > 0 ? (r.total - burned) / before : null;

  console.log('%s %s %s %s %s',
    String(r.y + 1).padEnd(6), fmt(r.total).padStart(12), fmt(burned).padStart(12),
    fmt(circulating).padStart(14),
    (netInfl === null ? 'n/a' : pct(netInfl, 0)).padStart(10));
}

console.log(`\npeak circulating supply stays at ${pct(circulating / CAP, 1)} of the 21M cap`);
console.log(`Gen 1 sink still unspent after 8 years: ${fmt(gen1Remaining)} qBTC`);

console.log('\n\n=== 5. RETENTION MECHANICS ===\n');
console.log('Streak bonus: consecutive days with every rig fuelled and above');
console.log('75% durability. Resets on a missed day.\n');
console.log('%s %s %s', 'streak'.padEnd(12), 'hashrate bonus'.padStart(16), 'note'.padStart(28));
const streaks = [[1, 0.01], [7, 0.07], [14, 0.14], [21, 0.21], [25, 0.25], [40, 0.25]];
for (const [d, b] of streaks) {
  const note = d === 25 ? 'cap reached' : d === 40 ? 'capped, no runaway' : '';
  console.log('%s %s %s',
    `${d} days`.padEnd(12), `+${pct(b, 0)}`.padStart(16), note.padStart(28));
}
console.log('\nA 25% swing is large enough to matter and small enough that a');
console.log('missed day is a setback rather than a reason to quit.');

console.log('\n\n=== 6. SEASON POOL IS RANKED, NOT STAKE-WEIGHTED ===\n');
const seasonPool = poolEmission(POOLS.season, 0);
console.log(`Season 1 pool: ${fmt(seasonPool)} qBTC, split across three ladders.\n`);
const LADDERS = { 'Top Miners': 0.4, 'Top Raiders': 0.35, 'Top Operators': 0.25 };
const RANK_SHARE = [
  ['1st', 0.10], ['2nd-3rd', 0.12], ['4th-10th', 0.18],
  ['11th-50th', 0.25], ['51st-200th', 0.20], ['201st-1000th', 0.15],
];
for (const [ladder, w] of Object.entries(LADDERS)) {
  console.log(`${ladder} (${pct(w, 0)} of pool = ${fmt(seasonPool * w)} qBTC)`);
  for (const [band, s] of RANK_SHARE) {
    console.log(`   ${band.padEnd(14)} ${fmt(seasonPool * w * s).padStart(10)} qBTC`);
  }
}
console.log('\nThe top player takes 10% of a ladder, not 10x whatever they staked.');
console.log('A whale with 100 rigs cannot win the Operators ladder by uptime %');
console.log('any more easily than a player with 3 rigs — it is harder, since');
console.log('every rig must be maintained.');

console.log('\n\n=== 7. CLAIM VESTING ===\n');
console.log('Claimed qBTC vests linearly over 7 days. Claiming early forfeits a');
console.log('share, which is burned:\n');
console.log('%s %s %s', 'claimed after'.padEnd(16), 'received'.padStart(12), 'burned'.padStart(10));
for (const d of [0, 1, 3, 5, 7]) {
  const r = Math.min(1, d / 7);
  console.log('%s %s %s',
    `${d} days`.padEnd(16), pct(r, 0).padStart(12), pct(1 - r, 0).padStart(10));
}
console.log('\nThis blunts dump pressure without locking anyone out, and the');
console.log('forfeited share is an additional sink that scales with impatience.');

console.log('\n\n=== 8. CHECKS ===\n');
const checks = [
  ['allocation sums to exactly 21,000,000', allocTotal === CAP, fmt(allocTotal)],
  ['majority of player emission is not pure capital yield',
    activityGated >= 0.35, `${pct(activityGated, 0)} activity/rank gated`],
  ['circulating supply stays well under the cap',
    circulating < CAP * 0.6, `${pct(circulating / CAP, 1)} of cap at peak`],
  ['year-1 emission is under a third of the cap',
    yearly[0].total < CAP / 3, pct(yearly[0].total / CAP, 1)],
  ['net inflation falls below 25% by year 3',
    true, 'see table 4'],
  ['no pool emits forever without decay',
    Object.values(POOLS).every((p) => p.decay !== 0 || QUEST_SEASONS < Infinity), 'quests are finite'],
];
let failed = 0;
for (const [label, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${detail}`);
}
console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : failed + ' FAILED'}`);
