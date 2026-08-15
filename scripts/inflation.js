/**
 * Emission, inflation, and Ponzi-exposure analysis.
 *
 * The sustainability GDD claims that burning 35-50% of emission makes the
 * economy collapse-proof. This script tests that claim against the actual
 * money flows, because burning tokens does not create value — it only moves
 * claims around between holders.
 *
 * The test that matters: how much of what players expect to extract is backed
 * by value entering from OUTSIDE the token system, versus by the deposits of
 * later players? That ratio is the definition of Ponzi exposure, and no amount
 * of burning changes it on its own.
 */

const YEAR = 365;

/* ---------------------------------------------------- EXTERNAL REVENUE */

// The only genuinely external inflows the design has today.
const GEN0_SUPPLY = 10_000;
const GEN0_PRICE_QRL = 0.069420;   // immutable constant in the deployed NFT
const GEN1_SUPPLY = 40_000;        // paid in qBTC -> burned -> NOT external
const ROYALTY_PCT = 0.05;
const QRL_STAKING_APY = 0.05;      // treasury staked on QRL proof-of-stake

/* ------------------------------------------------------------ EMISSION */

const CAP = 21_000_000;

/** Halving schedule: budget per day in a given epoch. */
function schedule(epochDays) {
  const r0 = CAP / 2 / epochDays;
  return { epochDays, r0 };
}

/** Emission during year `y` (0-indexed) under a halving schedule. */
function emissionInYear(sch, y) {
  let total = 0;
  for (let d = y * YEAR; d < (y + 1) * YEAR; d++) {
    const epoch = Math.floor(d / sch.epochDays);
    total += sch.r0 / Math.pow(2, epoch);
  }
  return total;
}

const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d });
const pct = (n, d = 1) => `${(n * 100).toFixed(d)}%`;

/* ------------------------------------------------------------ ANALYSIS */

console.log('=== 1. INFLATION UNDER THE PROPOSED SCHEDULE ===\n');
console.log('Burn share is taken from the simulation: 38% of emission is');
console.log('destroyed by repair, Cryo and acorn fees.\n');

const BURN_SHARE = 0.38;

function inflationTable(sch, label) {
  console.log(`--- ${label} (epoch = ${sch.epochDays} days) ---`);
  console.log('%s %s %s %s %s',
    'year'.padEnd(6), 'emitted'.padStart(13), 'circulating'.padStart(14),
    'gross infl'.padStart(12), 'net infl'.padStart(11));
  let circulating = 0;
  const rows = [];
  for (let y = 0; y < 8; y++) {
    const emitted = emissionInYear(sch, y);
    const burned = emitted * BURN_SHARE;
    const grossInfl = circulating > 0 ? emitted / circulating : Infinity;
    const netInfl = circulating > 0 ? (emitted - burned) / circulating : Infinity;
    circulating += emitted - burned;
    rows.push({ y, emitted, circulating, grossInfl, netInfl });
    console.log('%s %s %s %s %s',
      String(y + 1).padEnd(6),
      fmt(emitted).padStart(13),
      fmt(circulating).padStart(14),
      (grossInfl === Infinity ? 'n/a' : pct(grossInfl, 0)).padStart(12),
      (netInfl === Infinity ? 'n/a' : pct(netInfl, 0)).padStart(11));
  }
  console.log();
  return rows;
}

const fast = schedule(180);
const rowsFast = inflationTable(fast, 'as designed');
const slow = schedule(730);
const rowsSlow = inflationTable(slow, 'alternative: 2-year epochs');

console.log('A token inflating triple digits per year can only hold price if');
console.log('demand grows at least as fast. In this design the ONLY demand for');
console.log('qBTC is minting Gen 1 NFTs and paying maintenance fees, both of');
console.log('which are internal. Internal demand cannot outgrow internal supply');
console.log('indefinitely.\n');

console.log('\n=== 2. WHERE DOES REAL MONEY ACTUALLY ENTER? ===\n');

const gen0Revenue = GEN0_SUPPLY * GEN0_PRICE_QRL;
console.log(`Gen 0 mints        ${fmt(GEN0_SUPPLY)} x ${GEN0_PRICE_QRL} QRL = ${fmt(gen0Revenue, 1)} QRL   (one-off)`);
console.log(`Gen 1 mints        ${fmt(GEN1_SUPPLY)} paid in qBTC          = 0 QRL       (internal)`);
console.log(`Repair / Cryo      paid in qBTC                        = 0 QRL       (internal)`);
console.log(`Acorns / patches   paid in qBTC                        = 0 QRL       (internal)`);
console.log(`Secondary royalty  ${pct(ROYALTY_PCT, 0)} of volume                     = variable`);
console.log();
console.log(`TOTAL guaranteed external inflow: ${fmt(gen0Revenue, 1)} QRL`);
console.log();
console.log('Every "token sink" in the GDD is denominated in qBTC. Burning qBTC');
console.log('destroys a claim; it does not bring in a single QRL. So the sinks');
console.log('control supply but contribute nothing to backing.\n');

console.log('\n=== 3. PONZI EXPOSURE ===\n');
console.log('Floor price = treasury QRL / circulating qBTC. Anything a holder');
console.log('expects ABOVE that floor must be paid by a future buyer.\n');
console.log('  Ponzi exposure = 1 - (floor price / market price)\n');

let treasury = gen0Revenue;
console.log('%s %s %s %s',
  'year'.padEnd(6), 'treasury QRL'.padStart(14), 'circulating qBTC'.padStart(18),
  'floor QRL/qBTC'.padStart(17));
for (const r of rowsFast.slice(0, 6)) {
  treasury *= (1 + QRL_STAKING_APY); // staked on QRL PoS
  const floor = treasury / r.circulating;
  console.log('%s %s %s %s',
    String(r.y + 1).padEnd(6),
    fmt(treasury, 1).padStart(14),
    fmt(r.circulating).padStart(18),
    floor.toExponential(2).padStart(17));
}

const floorY1 = (gen0Revenue * 1.05) / rowsFast[0].circulating;
console.log();
console.log(`Floor after year 1: ${floorY1.toExponential(2)} QRL per qBTC.`);
console.log('At any plausible market price, Ponzi exposure is ~100%: essentially');
console.log('the entire value of qBTC depends on new buyers, not on backing.\n');

console.log('\n=== 4. WHAT WOULD IT TAKE TO BACK THE TOKEN? ===\n');
console.log('Treasury required to sustain a given floor, given year-1 supply of');
console.log(`${fmt(rowsFast[0].circulating)} qBTC and ${pct(QRL_STAKING_APY, 0)} staking yield:\n`);
console.log('%s %s %s %s',
  'target floor'.padEnd(16), 'treasury needed'.padStart(18),
  'Gen 0 price'.padStart(14), 'vs today'.padStart(12));
for (const target of [1e-6, 1e-5, 1e-4, 1e-3]) {
  const needed = target * rowsFast[0].circulating;
  const gen0Price = needed / GEN0_SUPPLY;
  console.log('%s %s %s %s',
    `${target.toExponential(0)} QRL`.padEnd(16),
    `${fmt(needed, 1)} QRL`.padStart(18),
    `${gen0Price.toFixed(4)} QRL`.padStart(14),
    `${fmt(gen0Price / GEN0_PRICE_QRL, 1)}x`.padStart(12));
}

console.log('\nThe deployed NFT has MINT_PRICE as an immutable constant, so raising');
console.log('Gen 0 revenue requires redeploying SquirrelGame.\n');

console.log('\n=== 5. THE FIX: MAKE BURNS ACCRUE VALUE ===\n');
console.log('Today a burned qBTC vanishes and nobody is better off. Add a');
console.log('redemption right and the same burn becomes a transfer of backing');
console.log('to everyone still holding:\n');
console.log('  redeem(amount) -> amount / totalSupply * treasuryQRL\n');
console.log('Forced burns (repair, Cryo, acorns) then RAISE the floor, because');
console.log('supply falls while the treasury does not. The maintenance sinks stop');
console.log('being supply theatre and start doing real work.\n');

console.log('Floor with redemption, 38% of emission burned each year:\n');
console.log('%s %s %s %s %s',
  'year'.padEnd(6), 'burned'.padStart(13), 'circulating'.padStart(14),
  'treasury'.padStart(12), 'floor'.padStart(13));
let t2 = gen0Revenue;
let circ = 0;
for (let y = 0; y < 6; y++) {
  const emitted = emissionInYear(fast, y);
  const burned = emitted * BURN_SHARE;
  circ += emitted - burned;
  t2 *= (1 + QRL_STAKING_APY);
  console.log('%s %s %s %s %s',
    String(y + 1).padEnd(6),
    fmt(burned).padStart(13),
    fmt(circ).padStart(14),
    fmt(t2, 1).padStart(12),
    (t2 / circ).toExponential(2).padStart(13));
}
console.log();
console.log('The floor still rises only slowly, because the treasury is tiny.');
console.log('Redemption fixes the STRUCTURE; it cannot fix the SCALE on its own.');
console.log('Both are needed: a redemption right, and an emission schedule sized');
console.log('against real inflow rather than against a Bitcoin-flavoured number.\n');

console.log('\n=== 6. EMISSION SIZED TO REVENUE ===\n');
console.log('Inverting the problem: given real inflow, what emission keeps a');
console.log('target floor stable? Emission is then a POLICY, not a constant.\n');
console.log('  sustainable annual emission = treasury yield / target floor\n');
console.log('%s %s %s',
  'treasury QRL'.padEnd(16), 'yield/yr'.padStart(12), 'qBTC/yr at 1e-4 floor'.padStart(24));
for (const tr of [694, 10_000, 100_000, 1_000_000]) {
  const yield_ = tr * QRL_STAKING_APY;
  console.log('%s %s %s',
    fmt(tr).padEnd(16), fmt(yield_, 1).padStart(12), fmt(yield_ / 1e-4).padStart(24));
}
console.log();
console.log(`Year-1 emission as designed: ${fmt(rowsFast[0].emitted)} qBTC.`);
console.log(`Backed at 1e-4 floor, that needs ${fmt(rowsFast[0].emitted * 1e-4 / QRL_STAKING_APY)} QRL in treasury.`);
console.log(`Available: ${fmt(gen0Revenue, 1)} QRL. Shortfall: ${fmt(rowsFast[0].emitted * 1e-4 / QRL_STAKING_APY / gen0Revenue, 0)}x.\n`);

console.log('\n=== VERDICT ===\n');
const verdicts = [
  ['Burning alone makes the economy non-Ponzi', false,
    'burns destroy claims, they do not add backing'],
  ['Emission schedule is sized against real revenue', false,
    `${fmt(rowsFast[0].emitted)} qBTC/yr vs ${fmt(gen0Revenue, 1)} QRL of inflow`],
  ['Year-1 inflation is survivable for a purely internal demand base', false,
    `${pct(rowsSlow[1].netInfl, 0)} net even on 2-year epochs`],
  ['Design forces active play and kills idle extraction', true,
    'durability + Cryo + energy all work as intended'],
  ['Seasonal decay prevents permanent whale dominance', true,
    'sound, and cheap if applied as a claim-time multiplier'],
];
for (const [label, ok, detail] of verdicts) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${detail}`);
}
