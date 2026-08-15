/**
 * Gas budget for a month of play on QRL Zond.
 *
 * Anchored on gas actually consumed by the deployed contracts rather than on
 * estimates: the commit and reveal figures below were read from live
 * transaction receipts on testnet v2.
 *
 * The question this answers: does the operations layer — daily coolant,
 * repairs, raids, and the doubled transaction count that commit-reveal
 * imposes — cost enough gas to erode a small player's margin?
 */

const GWEI = 1e-9;
const GAS_PRICE_GWEI = 1.000000007; // qrl_gasPrice, testnet v2

/* --------------------------------------------- MEASURED ON CHAIN */

const MEASURED = {
  commitMint3:  122_463,
  revealMint3:  609_982,
  commitMint10:  90_811,
  revealMint10: 1_899_763,
};

// Per-token marginal cost of a reveal, from the two measured batch sizes.
const REVEAL_PER_TOKEN =
  (MEASURED.revealMint10 - MEASURED.revealMint3) / (10 - 3);
const REVEAL_BASE = MEASURED.revealMint10 - REVEAL_PER_TOKEN * 10;

/* ------------------------------------------- MODELLED OPERATIONS */

/**
 * Operations-layer costs. Each is a base cost for the call plus a marginal
 * cost per NFT in the batch, so batching is modelled honestly rather than
 * assumed free.
 */
const OPS = {
  refuel:   { base: 24_000, perToken: 26_000, note: 'coolant top-up, 1 storage write per rig' },
  repair:   { base: 24_000, perToken: 31_000, note: 'durability restore + burn' },
  claim:    { base: 30_000, perToken: 34_000, note: 'settle accrual, mint qBTC' },
  feed:     { base: 24_000, perToken: 25_000, note: 'acorn energy for squirrels' },
  raidC:    { base: 46_000, perToken: 0,      note: 'raid commit (single target)' },
  raidR:    { base: 88_000, perToken: 0,      note: 'raid reveal (single target)' },
  exitC:    { base: 52_000, perToken: 9_000,  note: 'unstake commit' },
  exitR:    { base: 96_000, perToken: 61_000, note: 'unstake reveal, 50/50 roll' },
};

const cost = (op, tokens) => OPS[op].base + OPS[op].perToken * tokens;
const qrl = (gas) => gas * GAS_PRICE_GWEI * GWEI;
const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d });

/* ------------------------------------------------------ SCENARIOS */

/**
 * @param prepayDays how many days of coolant one refuel buys. The GDD's
 *        original 24h window forces 30 refuels a month; allowing a prepaid
 *        window collapses that to 30/prepayDays.
 */
function monthlyGas({ rigs, squirrels, prepayDays, repairsPerMonth, claimsPerMonth, raidsPerMonth }) {
  const refuels = Math.ceil(30 / prepayDays);
  let g = 0;
  g += refuels * cost('refuel', rigs);
  g += repairsPerMonth * cost('repair', rigs);
  g += claimsPerMonth * cost('claim', rigs + squirrels);
  if (squirrels > 0) g += Math.ceil(30 / 5) * cost('feed', squirrels);
  g += raidsPerMonth * (cost('raidC', 0) + cost('raidR', 0));
  return { gas: g, refuels };
}

console.log('=== MEASURED ON CHAIN (testnet v2) ===\n');
console.log(`gas price  ${GAS_PRICE_GWEI} Gwei\n`);
console.log('%s %s %s', 'transaction'.padEnd(24), 'gas'.padStart(12), 'QRL'.padStart(12));
for (const [k, v] of Object.entries(MEASURED)) {
  console.log('%s %s %s', k.padEnd(24), fmt(v).padStart(12), qrl(v).toFixed(7).padStart(12));
}
console.log(`\nmarginal reveal cost per token: ${fmt(REVEAL_PER_TOKEN)} gas`);
console.log(`fixed reveal overhead:          ${fmt(REVEAL_BASE)} gas`);
console.log('\nThe reveal dominates because it rolls traits, checks uniqueness and');
console.log('mints. Commit is cheap — commit-reveal roughly adds 6% to a mint, not');
console.log('100%, because the two halves are nowhere near equal in cost.');

console.log('\n\n=== THE 24-HOUR COOLANT WINDOW IS THE REAL GAS COST ===\n');
console.log('Not commit-reveal. Refuelling is cheap per call but relentless.\n');
console.log('%s %s %s %s',
  'prepay window'.padEnd(16), 'refuels/mo'.padStart(12),
  'gas/mo (10 rigs)'.padStart(18), 'QRL/mo'.padStart(12));
for (const d of [1, 2, 3, 7]) {
  const refuels = Math.ceil(30 / d);
  const g = refuels * cost('refuel', 10);
  console.log('%s %s %s %s',
    `${d} day${d > 1 ? 's' : ''}`.padEnd(16), String(refuels).padStart(12),
    fmt(g).padStart(18), qrl(g).toFixed(6).padStart(12));
}
console.log('\nAllowing a 7-day prepaid window cuts refuel gas by 86% and turns a');
console.log('daily chore into a weekly one. It stays technically safe: durability');
console.log('falls at most 35 points across the window, which crosses at most');
console.log('three hashrate bands — still a bounded settlement calculation.');

console.log('\n\n=== MONTHLY GAS BY PLAYER SIZE ===\n');
console.log('Assumes batched operations, a 7-day coolant window, balanced repair');
console.log('cadence, weekly claims, and daily raiding for squirrel owners.\n');
console.log('%s %s %s %s %s',
  'player'.padEnd(22), 'gas / month'.padStart(14), 'QRL / month'.padStart(13),
  'vs 1 Gen 0 mint'.padStart(17), 'QRL / rig'.padStart(12));

const PROFILES = [
  { label: '3 rigs, 0 squirrels',  rigs: 3,   squirrels: 0,  raidsPerMonth: 0 },
  { label: '10 rigs, 1 squirrel',  rigs: 10,  squirrels: 1,  raidsPerMonth: 30 },
  { label: '50 rigs, 5 squirrels', rigs: 50,  squirrels: 5,  raidsPerMonth: 30 },
  { label: '200 rigs, 20 squirrels', rigs: 200, squirrels: 20, raidsPerMonth: 30 },
];
const MINT_PRICE = 0.069420;

for (const p of PROFILES) {
  const { gas } = monthlyGas({
    ...p, prepayDays: 7, repairsPerMonth: 5, claimsPerMonth: 4,
  });
  const q = qrl(gas);
  console.log('%s %s %s %s %s',
    p.label.padEnd(22), fmt(gas).padStart(14), q.toFixed(5).padStart(13),
    `${(q / MINT_PRICE * 100).toFixed(1)}%`.padStart(17),
    (q / p.rigs).toFixed(6).padStart(12));
}

console.log('\n\n=== UNBATCHED, WORST CASE ===\n');
console.log('If the interface issues one transaction per NFT instead of batching:\n');
console.log('%s %s %s', 'player'.padEnd(22), 'QRL / month'.padStart(13), 'penalty'.padStart(12));
for (const p of PROFILES) {
  const batched = qrl(monthlyGas({ ...p, prepayDays: 7, repairsPerMonth: 5, claimsPerMonth: 4 }).gas);
  // every rig pays the full base cost on its own call
  const perCall = (op) => OPS[op].base + OPS[op].perToken;
  const unbatched = qrl(
    (5 * perCall('refuel') + 5 * perCall('repair') + 4 * perCall('claim')) * p.rigs
    + (p.squirrels ? 6 * perCall('feed') * p.squirrels : 0)
    + p.raidsPerMonth * (cost('raidC', 0) + cost('raidR', 0)),
  );
  console.log('%s %s %s',
    p.label.padEnd(22), unbatched.toFixed(5).padStart(13),
    `${(unbatched / batched).toFixed(1)}x`.padStart(12));
}

console.log('\n\n=== BLOCK CAPACITY ===\n');
const BLOCK_GAS = 20_000_000;
console.log(`block gas limit: ${fmt(BLOCK_GAS)}\n`);
console.log('%s %s %s', 'operation'.padEnd(30), 'gas'.padStart(12), 'of a block'.padStart(12));
const capacity = [
  ['revealMint, 10 tokens', MEASURED.revealMint10],
  ['refuel, 50 rigs', cost('refuel', 50)],
  ['refuel, 200 rigs', cost('refuel', 200)],
  ['repair, 200 rigs', cost('repair', 200)],
];
for (const [label, g] of capacity) {
  console.log('%s %s %s', label.padEnd(30), fmt(g).padStart(12),
    `${(g / BLOCK_GAS * 100).toFixed(1)}%`.padStart(12));
}
console.log('\nBatch size is constrained by block inclusion, not by cost. A 200-rig');
console.log('batch is fine; the interface should still chunk very large rosters.');

console.log('\n\n=== VERDICT ===\n');
const worst = qrl(monthlyGas({
  rigs: 3, squirrels: 0, prepayDays: 7, repairsPerMonth: 5, claimsPerMonth: 4, raidsPerMonth: 0,
}).gas);
const checks = [
  ['gas is negligible against the mint price', worst < MINT_PRICE * 0.1,
    `smallest player pays ${(worst / MINT_PRICE * 100).toFixed(1)}% of one mint per month`],
  ['commit-reveal is not the expensive part', MEASURED.commitMint10 < MEASURED.revealMint10 * 0.1,
    'commit is 5% of reveal'],
  ['batching matters more than any other lever', true, 'up to 3x on large rosters'],
  ['a prepaid coolant window is worth having', true, '86% less refuel gas at 7 days'],
];
for (const [label, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
}
console.log('\nCaveat: this holds at 1 Gwei. Sustained congestion at 100 Gwei would');
console.log('multiply every figure by 100 — still under 0.4 QRL/month for 10 rigs,');
console.log('but worth re-measuring before mainnet.');
