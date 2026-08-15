/**
 * Prints and self-checks the qBTC tokenomics.
 *
 * Squirrel Game keeps Wolf Game's game *dynamics* exactly, but redenominates
 * qBTC to a Bitcoin-style 21,000,000 hard cap. Every qBTC quantity is Wolf
 * Game's WOOL figure multiplied by SCALE = 21e6 / 2.4e9 = 7/800. This script
 * asserts that the scaling is exact and that the derived ratios still match.
 */
const WOLF = {
  cap: 2_400_000_000,
  dailyRate: 10_000,
  mintTiers: [20_000, 40_000, 80_000],
};

const CAP = 21_000_000;
const SCALE = CAP / WOLF.cap; // 7/800

const MAX_TOKENS = 50_000;
const PAID_TOKENS = MAX_TOKENS / 5; // 10,000 Gen 0
const TAX_PCT = 20;
const MIN_EXIT_DAYS = 2;

const dailyRate = WOLF.dailyRate * SCALE;
const mintTiers = WOLF.mintTiers.map((t) => t * SCALE);

// Gen 1 supply is split 10k / 20k / 10k across the three price tiers,
// mirroring the MAX_TOKENS*2/5 and *4/5 boundaries in SquirrelGame.mintCost.
const tierCounts = [
  (MAX_TOKENS * 2) / 5 - PAID_TOKENS, // 10,000
  (MAX_TOKENS * 4) / 5 - (MAX_TOKENS * 2) / 5, // 20,000
  MAX_TOKENS - (MAX_TOKENS * 4) / 5, // 10,000
];
const totalBurn = mintTiers.reduce((a, t, i) => a + t * tierCounts[i], 0);
const wolfBurn = WOLF.mintTiers.reduce((a, t, i) => a + t * tierCounts[i], 0);

const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });

console.log('=== qBTC EMISSION MODEL ===\n');
console.log(`scale factor            ${SCALE}  (= 7/800, from 21e6 / 2.4e9)\n`);

console.log('%s %s %s', 'quantity'.padEnd(26), 'Wolf Game (WOOL)'.padStart(18), 'Squirrel Game (qBTC)'.padStart(22));
const row = (label, w, q) => console.log('%s %s %s', label.padEnd(26), fmt(w).padStart(18), fmt(q).padStart(22));
row('hard cap', WOLF.cap, CAP);
row('daily rate / miner', WOLF.dailyRate, dailyRate);
row('mint cost tier 1', WOLF.mintTiers[0], mintTiers[0]);
row('mint cost tier 2', WOLF.mintTiers[1], mintTiers[1]);
row('mint cost tier 3', WOLF.mintTiers[2], mintTiers[2]);
row('total Gen 1 burn', wolfBurn, totalBurn);

console.log('\n=== DERIVED RATIOS (must match Wolf Game) ===\n');
const checks = [];
const check = (label, got, want, unit = '') => {
  const ok = Math.abs(got - want) < 1e-9;
  checks.push(ok);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${fmt(got)}${unit}` +
    (ok ? '' : `   expected ${fmt(want)}${unit}`),
  );
};

check('days of mining to afford cheapest Gen 1 mint', mintTiers[0] / dailyRate,
  WOLF.mintTiers[0] / WOLF.dailyRate, ' d');
check('total Gen 1 burn as fraction of cap', totalBurn / CAP, wolfBurn / WOLF.cap);
check('miner-days of emission available', CAP / dailyRate, WOLF.cap / WOLF.dailyRate, ' d');
check('mint tier 2 / tier 1 ratio', mintTiers[1] / mintTiers[0], 2);
check('mint tier 3 / tier 1 ratio', mintTiers[2] / mintTiers[0], 4);

console.log('\n=== EXACTNESS IN WEI (BigInt, no float) ===\n');
console.log('Scaling by 7/800 must divide evenly, or the contract literals would');
console.log('not equal the intended value. Checked against the literals as written.\n');

const WEI = 10n ** 18n;
const SCALE_NUM = 7n;
const SCALE_DEN = 800n;

/** Exact WOOL-wei -> qBTC-wei conversion, asserting the division is clean. */
const scaleWei = (woolUnits) => {
  const n = BigInt(woolUnits) * WEI * SCALE_NUM;
  return { wei: n / SCALE_DEN, remainder: n % SCALE_DEN };
};

// The literal actually written in each .hyp source file.
const LITERALS = {
  DAILY_QBTC_RATE: 875n * WEI / 10n, // 87.5 ether
  'mintCost tier 1': 175n * WEI,
  'mintCost tier 2': 350n * WEI,
  'mintCost tier 3': 700n * WEI,
  MAXIMUM_GLOBAL_QBTC: 21_000_000n * WEI,
};
const SOURCE = {
  DAILY_QBTC_RATE: WOLF.dailyRate,
  'mintCost tier 1': WOLF.mintTiers[0],
  'mintCost tier 2': WOLF.mintTiers[1],
  'mintCost tier 3': WOLF.mintTiers[2],
  MAXIMUM_GLOBAL_QBTC: WOLF.cap,
};

for (const [label, literal] of Object.entries(LITERALS)) {
  const { wei, remainder } = scaleWei(SOURCE[label]);
  const ok = remainder === 0n && wei === literal;
  checks.push(ok);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(24)} ${String(wei).padStart(28)} wei` +
    (ok ? '' : `  != literal ${literal} (rem ${remainder})`),
  );
}

console.log('\n=== CONTRACT SOURCE MATCHES THIS MODEL ===\n');
console.log('Greps the .hyp sources so this report cannot drift from the code.\n');

const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'contracts', f), 'utf8');
const farmSrc = read('MiningFarm.hyp');
const gameSrc = read('SquirrelGame.hyp');

/** Parses an `ether` literal out of source and returns it in wei. */
const etherLiteralToWei = (text) => {
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole + frac.padEnd(18, '0').slice(0, 18));
};

const sourceChecks = [
  ['DAILY_QBTC_RATE', farmSrc, /DAILY_QBTC_RATE\s*=\s*([\d.]+)\s*ether/],
  ['MAXIMUM_GLOBAL_QBTC', farmSrc, /MAXIMUM_GLOBAL_QBTC\s*=\s*([\d.]+)\s*ether/],
  ['QBTC_CLAIM_TAX_PERCENTAGE', farmSrc, /QBTC_CLAIM_TAX_PERCENTAGE\s*=\s*(\d+)/],
  ['mintCost tier 1', gameSrc, /MAX_TOKENS \* 2\) \/ 5\) return ([\d.]+) ether/],
  ['mintCost tier 2', gameSrc, /MAX_TOKENS \* 4\) \/ 5\) return ([\d.]+) ether/],
  ['mintCost tier 3', gameSrc, /return ([\d.]+) ether;\s*\n\s*}/],
];

const EXPECTED_SOURCE = {
  DAILY_QBTC_RATE: LITERALS.DAILY_QBTC_RATE,
  MAXIMUM_GLOBAL_QBTC: LITERALS.MAXIMUM_GLOBAL_QBTC,
  QBTC_CLAIM_TAX_PERCENTAGE: BigInt(TAX_PCT),
  'mintCost tier 1': LITERALS['mintCost tier 1'],
  'mintCost tier 2': LITERALS['mintCost tier 2'],
  'mintCost tier 3': LITERALS['mintCost tier 3'],
};

for (const [label, src, re] of sourceChecks) {
  const m = src.match(re);
  const isPct = label.endsWith('PERCENTAGE');
  const found = m ? (isPct ? BigInt(m[1]) : etherLiteralToWei(m[1])) : null;
  const ok = found !== null && found === EXPECTED_SOURCE[label];
  checks.push(ok);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} source says ${m ? m[1] : '(not found)'}` +
    (ok ? '' : `  expected ${EXPECTED_SOURCE[label]} wei`),
  );
}

console.log('\n=== TIME-TO-CAP SCENARIOS ===\n');
console.log('Emission only accrues while Quantum Computers are staked.');
console.log('%s %s', 'miners staked'.padEnd(20), 'days to reach 21M cap'.padStart(24));
for (const staked of [100, 1_000, 5_000, 10_000, 45_000]) {
  const days = CAP / (staked * dailyRate);
  console.log('%s %s', String(staked).padEnd(20), fmt(days).padStart(24));
}

console.log('\n=== GAME PARAMETERS ===\n');
console.log(`max supply              ${fmt(MAX_TOKENS)} NFTs`);
console.log(`Gen 0 (native QRL)      ${fmt(PAID_TOKENS)} @ 0.069420 QRL`);
console.log(`Gen 1+ (burn qBTC)      ${fmt(MAX_TOKENS - PAID_TOKENS)}`);
console.log(`Squirrel mint chance    10%   (Tier 1 60% / Tier 2 30% / Tier 3 10%)`);
console.log(`alpha scores            Tier 1 = 6, Tier 2 = 7, Tier 3 = 8`);
console.log(`claim tax to Drey       ${TAX_PCT}%`);
console.log(`unstake risk            50% chance the Drey takes all pending yield`);
console.log(`minimum stake time      ${MIN_EXIT_DAYS} days`);

const failed = checks.filter((c) => !c).length;
console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
