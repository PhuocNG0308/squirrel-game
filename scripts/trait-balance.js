/**
 * Trait modifier balance report.
 *
 * Answers one question: is the average NFT better or worse than the baseline
 * the economy is priced against?
 *
 * That baseline is not a matter of taste. `fullRateDailyYield` is derived from
 * QuantumFarm's accumulator, which applies no trait modifiers at all, so every
 * price computed from it — coolant, repair, acorns, firewalls — is pinned to
 * exactly NEUTRAL. If the probability-weighted mean of a table sits above
 * neutral on a cost stat, the typical player pays more than the reference
 * income assumes, forever, and nothing in the contracts will ever say so.
 *
 * Both inputs are parsed out of the contract sources rather than copied here,
 * so this report cannot drift away from what is deployed.
 *
 *   rarities/aliases  <- contracts/SquirrelGame.hyp   (Walker alias tables)
 *   modifier tables   <- contracts/TraitStats.hyp
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NEUTRAL = 10000;

/** Which TraitStats table drives which trait slot, and which way is good. */
const SLOTS = [
  { table: 'CHASSIS_DECAY', slot: 0,  lowerBetter: true,  label: 'Chassis / wear' },
  { table: 'COOLING_COST',  slot: 1,  lowerBetter: true,  label: 'Cooling / coolant' },
  { table: 'CORE_HASHRATE', slot: 4,  lowerBetter: false, label: 'Power core / hashrate' },
  { table: 'MOUNT_REPAIR',  slot: 7,  lowerBetter: true,  label: 'Mounting / repair' },
  { table: 'HEADGEAR_TAX',  slot: 10, lowerBetter: false, label: 'Headgear / tax share' },
  { table: 'OPTICS_ODDS',   slot: 12, lowerBetter: false, label: 'Optics / raid odds' },
  { table: 'GEAR_ENERGY',   slot: 15, lowerBetter: true,  label: 'Gear / energy draw' },
  { table: 'PAWS_STEAL',    slot: 16, lowerBetter: false, label: 'Paws / plunder' },
];

const RIG_SLOTS = [0, 1, 4, 7];

function read(file) {
  return fs.readFileSync(path.join(ROOT, 'contracts', file), 'utf8');
}

/** `uint16[5] private CHASSIS_DECAY = [11000, ...];` */
function modifierTables() {
  const src = read('TraitStats.hyp');
  const out = {};
  for (const m of src.matchAll(/uint16\[\d+\]\s+private\s+(\w+)\s*=\s*\[([^\]]+)\]/g)) {
    out[m[1]] = m[2].split(',').map((x) => Number(x.trim()));
  }
  return out;
}

/** `rarities[4] = [255, 253, 92];` and the matching aliases. */
function aliasTables() {
  const src = read('SquirrelGame.hyp');
  const grab = (name) => {
    const out = {};
    const re = new RegExp(`${name}\\[(\\d+)\\]\\s*=\\s*\\[([^\\]]+)\\]`, 'g');
    for (const m of src.matchAll(re)) out[Number(m[1])] = m[2].split(',').map((x) => Number(x.trim()));
    return out;
  };
  return { rarities: grab('rarities'), aliases: grab('aliases') };
}

/**
 * Exact index distribution for a slot, mirroring SquirrelGame.selectTrait:
 * the low byte picks a bucket uniformly, the high byte takes that bucket with
 * probability rarities[b]/256 and its alias otherwise.
 */
function distribution(rarities, aliases, slot) {
  const r = rarities[slot];
  const a = aliases[slot];
  const n = r.length;
  const p = new Array(n).fill(0);
  for (let b = 0; b < n; b++) {
    p[b] += (1 / n) * (r[b] / 256);
    p[a[b]] += (1 / n) * (1 - r[b] / 256);
  }
  return p;
}

function main() {
  const mods = modifierTables();
  const { rarities, aliases } = aliasTables();

  let fatal = false;
  const rows = [];

  for (const s of SLOTS) {
    const v = mods[s.table];
    const p = distribution(rarities, aliases, s.slot);

    if (!v) { console.error(`missing table ${s.table}`); fatal = true; continue; }
    if (v.length !== p.length) {
      console.error(
        `${s.table} has ${v.length} entries but slot ${s.slot} rolls ${p.length} indices`,
      );
      fatal = true;
      continue;
    }

    let mean = 0, worse = 0, better = 0;
    v.forEach((x, i) => {
      mean += p[i] * x;
      const good = s.lowerBetter ? x < NEUTRAL : x > NEUTRAL;
      const bad = s.lowerBetter ? x > NEUTRAL : x < NEUTRAL;
      if (bad) worse += p[i];
      if (good) better += p[i];
    });
    // stated as the player's advantage, so cost stats read the same way as
    // income stats: positive is good for the player in every row
    const edge = s.lowerBetter ? (NEUTRAL - mean) / NEUTRAL : (mean - NEUTRAL) / NEUTRAL;
    rows.push({ ...s, v, p, mean, worse, better, edge });
  }
  if (fatal) process.exit(1);

  const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;

  console.log('=== PER-SLOT BALANCE ===\n');
  console.log('%s %s %s %s %s', 'slot'.padEnd(23), 'E[mod]'.padStart(7),
    'edge'.padStart(7), 'worse'.padStart(7), 'better'.padStart(7));
  for (const r of rows) {
    console.log('%s %s %s %s %s', r.label.padEnd(23),
      String(Math.round(r.mean)).padStart(7),
      (r.edge >= 0 ? '+' : '') + pct(r.edge).padStart(6),
      pct(r.worse).padStart(7), pct(r.better).padStart(7));
  }

  console.log('\n=== ROLL DISTRIBUTION ===\n');
  for (const r of rows) {
    console.log(r.label);
    console.log('   ', r.v.map((x, i) => `${x} (${pct(r.p[i], 0)})`).join('   '));
  }

  console.log('\n=== A WHOLE RIG ===\n');
  const rigRows = rows.filter((r) => RIG_SLOTS.includes(r.slot));
  const allBad = rigRows.reduce((acc, r) => acc * r.worse, 1);
  const noneGood = rigRows.reduce((acc, r) => acc * (1 - r.better), 1);
  console.log('every stat is a penalty          ', pct(allBad));
  console.log('not one stat beats neutral       ', pct(noneGood));
  console.log('at least one stat beats neutral  ', pct(1 - noneGood));

  console.log('\n=== CHECKS ===\n');
  const checks = [];
  for (const r of rows) {
    checks.push([
      `${r.label} is within 1% of neutral on average`,
      Math.abs(r.edge) <= 0.01,
      `${r.edge >= 0 ? '+' : ''}${pct(r.edge)}`,
    ]);
  }
  // The point of request 4: a downside has to actually exist, or fusion has
  // nothing to repair and opening a mint carries no risk.
  for (const r of rows) {
    checks.push([`${r.label} can roll worse than neutral`, r.worse > 0, pct(r.worse)]);
    checks.push([`${r.label} can roll better than neutral`, r.better > 0, pct(r.better)]);
  }
  /**
   * The starter pack is minted at a fixed trait index, so that index must be
   * exactly neutral in every table the pack touches. Getting this wrong once
   * shipped a starter rig that was the worst machine in the collection, and
   * nothing in the test suite noticed, because both halves were individually
   * defensible.
   */
  const starterIdx = Number(
    /STARTER_TRAIT_INDEX\s*=\s*(\d+)/.exec(read('SquirrelGame.hyp'))[1],
  );
  for (const r of rows.filter((x) => RIG_SLOTS.includes(x.slot))) {
    checks.push([
      `${r.label} is exactly neutral at the starter index`,
      r.v[starterIdx] === NEUTRAL,
      `index ${starterIdx} = ${r.v[starterIdx]}`,
    ]);
  }

  // uint16 headroom: the largest table value plus the generation bonus must fit
  const GEN_HASHRATE_BONUS_BPS = 600, MAX_GEN_SCALING = 8;
  const topHash = Math.max(...mods.CORE_HASHRATE);
  const scaled = Math.round((topHash * (10000 + MAX_GEN_SCALING * GEN_HASHRATE_BONUS_BPS)) / 10000);
  checks.push(['best core at max generation fits uint16', scaled <= 65535, String(scaled)]);

  let failed = 0;
  for (const [label, ok, detail] of checks) {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${detail}`);
  }
  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
