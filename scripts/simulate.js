/**
 * Economic simulation for the sustainable-operations layer.
 *
 * Answers three questions before any contract is written:
 *   1. Does a hard 21,000,000 emission cap survive a large player base?
 *   2. What repair / Cryo pricing burns 35-50% of emission while keeping net
 *      profit positive for an attentive player?
 *   3. Does diligent play actually beat neglect, or is the dominant strategy
 *      to let rigs rot?
 *
 * Emission model
 * --------------
 * Per-rig rate is NOT fixed. The network emits a fixed budget per day, split
 * pro-rata by effective hashrate, and that budget halves every epoch:
 *
 *     rate(day) = R0 / 2^floor(day / EPOCH_DAYS)
 *     total     = R0 * EPOCH_DAYS * (1 + 1/2 + 1/4 + ...) = R0 * EPOCH_DAYS * 2
 *
 * Choosing R0 * EPOCH_DAYS = CAP / 2 makes the series converge exactly on the
 * cap without ever reaching it, so mining never hard-stops. A flat per-rig
 * rate under a hard cap does: 45,000 rigs at 87.5/day exhausts 21M in 5.3 days.
 *
 * Fees are percentages of realised yield rather than fixed token amounts, so
 * they cannot become unpayable when per-rig output falls (the "fixed fee trap"
 * and the bear-market death spiral).
 */

const CAP = 21_000_000;
const EPOCH_DAYS = 180;
const R0 = CAP / 2 / EPOCH_DAYS; // network-wide qBTC/day in epoch 0

const DAYS = 720; // 4 epochs

/* ------------------------------------------------------------ RIG MODEL */

const DURABILITY_MAX = 100;
const DURABILITY_DECAY_PER_DAY = 5;

/** Hashrate multiplier by remaining durability. */
function hashrateMultiplier(d) {
  if (d <= 0) return 0;
  if (d >= 75) return 1.0;
  if (d >= 50) return 0.8;
  if (d >= 20) return 0.5;
  return 0.2;
}

const CRITICAL_MAX = 19;
const EXPLODE_CHANCE_PER_DAY = 0.10;
const CRITICAL_REPAIR_PENALTY = 1.5;

/**
 * Flat service fee charged per repair *action*, as a fraction of the rig's
 * gross daily yield.
 *
 * Without this the design has no dilemma: repair cost is linear in points, so
 * topping up 5 points daily and 30 points every sixth day cost exactly the
 * same. A per-action fee makes frequent repairs genuinely more expensive,
 * which is what puts "repair often for uptime" in real tension with "repair
 * rarely for lower fees".
 */
const REPAIR_SERVICE_FEE = 0.02;

const TAX_PCT = 0.20;  // to the Drey
const CRYO_PCT = 0.10; // burned

/* ------------------------------------------------- SQUIRREL MODEL (Drey) */

const ENERGY_MAX = 100;
const ENERGY_DECAY_PER_DAY = 10;

function taxShareMultiplier(e) {
  if (e >= 50) return 1.0;
  if (e >= 20) return 0.5;
  return 0;
}

/* ------------------------------------------------------------- STRATEGY */

const STRATEGIES = {
  // repairs to full every day, always fuels
  diligent: { repairAt: 100, fuels: true },
  // lets the rig slide to Overheating before repairing
  balanced: { repairAt: 74, fuels: true },
  // squeezes it, repairing only at Critical (pays the 1.5x penalty)
  lazy: { repairAt: 19, fuels: true },
  // abandons the rig
  neglect: { repairAt: -1, fuels: false },
};

/** Deterministic PRNG so runs are reproducible. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * @param repairPctPerPoint cost to restore one durability point, as a
 *        fraction of the rig's gross daily yield
 */
function simulate({ rigCount, squirrelCount, repairPctPerPoint, mix, seed = 42, days = DAYS }) {
  const rand = rng(seed);

  const rigs = [];
  const strategyNames = Object.keys(mix);
  for (let i = 0; i < rigCount; i++) {
    // deterministic assignment matching the requested mix
    let r = (i / rigCount);
    let acc = 0;
    let chosen = strategyNames[0];
    for (const name of strategyNames) {
      acc += mix[name];
      if (r < acc) { chosen = name; break; }
    }
    rigs.push({ durability: DURABILITY_MAX, strategy: chosen, alive: true, net: 0, gross: 0 });
  }

  let emitted = 0;
  let burned = 0;
  let toSquirrels = 0;
  let exploded = 0;

  const perStrategy = {};
  for (const n of strategyNames) perStrategy[n] = { net: 0, gross: 0, count: 0, alive: 0 };
  for (const r of rigs) perStrategy[r.strategy].count++;

  let squirrelEnergy = ENERGY_MAX;
  let squirrelIncome = 0;
  let acornBurn = 0;

  const timeline = [];

  for (let day = 0; day < days; day++) {
    const epoch = Math.floor(day / EPOCH_DAYS);
    const networkBudget = R0 / Math.pow(2, epoch);

    // total effective hashrate this day
    let totalHash = 0;
    for (const r of rigs) {
      if (!r.alive) continue;
      totalHash += hashrateMultiplier(r.durability);
    }
    if (totalHash === 0) { timeline.push({ day, emitted, burned, netPerRig: 0 }); continue; }

    // remaining headroom under the hard cap
    const headroom = Math.max(0, CAP - emitted);
    const todaysEmission = Math.min(networkBudget, headroom);

    let dayTax = 0;
    let dayBurn = 0;

    // Yield a rig would earn today at full durability. Repair is priced off
    // this rather than off actual output, because a rig at 0 durability earns
    // nothing — pricing off output would make reviving a dead rig free, and
    // would make repair cost collapse exactly when the rig needs it most.
    const yieldPerHash = todaysEmission / totalHash;

    for (const r of rigs) {
      if (!r.alive) continue;
      const s = STRATEGIES[r.strategy];

      // An unfuelled rig is switched off: it mines nothing, and because it is
      // not running it neither wears down nor risks exploding.
      if (!s.fuels) continue;

      const hash = hashrateMultiplier(r.durability);
      const gross = yieldPerHash * hash;

      if (hash > 0) {
        r.gross += gross;
        emitted += gross;

        const tax = gross * TAX_PCT;
        const cryo = gross * CRYO_PCT;
        dayTax += tax;
        dayBurn += cryo;
        r.net += gross - tax - cryo;

        // durability decays from a day of mining
        r.durability = Math.max(0, r.durability - DURABILITY_DECAY_PER_DAY);

        // explosion risk applies while operating in the Critical band
        if (r.durability > 0 && r.durability <= CRITICAL_MAX
            && rand() < EXPLODE_CHANCE_PER_DAY) {
          r.alive = false;
          exploded++;
          continue;
        }
      }

      // Repair is reachable at any durability, including 0 (Shutdown), so a
      // stalled rig can always be brought back.
      if (s.repairAt >= 0 && r.durability <= s.repairAt) {
        const points = DURABILITY_MAX - r.durability;
        const penalty = r.durability <= CRITICAL_MAX ? CRITICAL_REPAIR_PENALTY : 1;
        const repair = (points * repairPctPerPoint * penalty + REPAIR_SERVICE_FEE) * yieldPerHash;
        r.repairs = (r.repairs || 0) + 1;
        r.durability = DURABILITY_MAX;
        r.net -= repair;
        dayBurn += repair;
      }
    }

    burned += dayBurn;
    toSquirrels += dayTax;

    // Drey side: energy decays, acorns are burned to restore it
    squirrelEnergy = Math.max(0, squirrelEnergy - ENERGY_DECAY_PER_DAY);
    const share = taxShareMultiplier(squirrelEnergy);
    squirrelIncome += dayTax * share;
    if (squirrelEnergy < 50) {
      // refill to full; acorns cost a fraction of tax income
      const acorns = (ENERGY_MAX - squirrelEnergy) * 0.002 * dayTax;
      acornBurn += acorns;
      burned += acorns;
      squirrelEnergy = ENERGY_MAX;
    }

    if (day % 30 === 0 || day === days - 1) {
      timeline.push({
        day,
        epoch,
        emittedPct: (emitted / CAP) * 100,
        burnedPct: emitted > 0 ? (burned / emitted) * 100 : 0,
        circulating: emitted - burned,
        aliveRigs: rigs.filter((r) => r.alive).length,
      });
    }
  }

  for (const r of rigs) {
    perStrategy[r.strategy].net += r.net;
    perStrategy[r.strategy].gross += r.gross;
    if (r.alive) perStrategy[r.strategy].alive++;
  }

  return {
    emitted, burned, toSquirrels, exploded, timeline, perStrategy,
    circulating: emitted - burned,
    burnRate: emitted > 0 ? burned / emitted : 0,
    capUsedPct: (emitted / CAP) * 100,
    squirrelIncome, acornBurn,
  };
}

/* ------------------------------------------------------------- REPORTING */

const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d });

function main() {
  console.log('=== EMISSION SCHEDULE ===\n');
  console.log(`hard cap            ${fmt(CAP)} qBTC (never minted beyond this)`);
  console.log(`epoch length        ${EPOCH_DAYS} days`);
  console.log(`epoch 0 budget      ${fmt(R0, 2)} qBTC/day network-wide`);
  console.log('\nA halving series converges on the cap without reaching it, so');
  console.log('mining never hard-stops regardless of how many rigs join:\n');
  console.log('%s %s %s', 'epoch'.padEnd(8), 'qBTC/day'.padStart(14), 'cumulative'.padStart(16));
  let cum = 0;
  for (let e = 0; e < 8; e++) {
    const rate = R0 / Math.pow(2, e);
    cum += rate * EPOCH_DAYS;
    console.log('%s %s %s', String(e).padEnd(8), fmt(rate, 1).padStart(14), fmt(cum).padStart(16));
  }
  console.log(`${' '.repeat(8)} ${'...'.padStart(14)} ${fmt(CAP).padStart(16)}  (limit)`);

  console.log('\n\n=== WHY A FLAT PER-RIG RATE FAILS UNDER A HARD CAP ===\n');
  console.log('%s %s %s', 'rigs'.padEnd(10), 'flat 87.5/day'.padStart(18), 'halving model'.padStart(20));
  for (const n of [1_000, 5_000, 20_000, 45_000]) {
    const flatDays = CAP / (n * 87.5);
    console.log('%s %s %s', fmt(n).padEnd(10),
      `${fmt(flatDays, 1)} days`.padStart(18), 'unbounded'.padStart(20));
  }

  console.log('\n\n=== CALIBRATING REPAIR PRICE ===\n');
  console.log('Repair cost per durability point, as a fraction of the rig\'s gross');
  console.log('daily yield. Target: 35-50% of emission burned, net profit positive,');
  console.log('and diligent play beating neglect.\n');

  const mix = { diligent: 0.3, balanced: 0.4, lazy: 0.2, neglect: 0.1 };
  console.log('%s %s %s %s %s',
    'repair%/pt'.padEnd(12), 'burn share'.padStart(12), 'net/gross'.padStart(12),
    'exploded'.padStart(10), 'verdict'.padStart(10));

  let best = null;
  for (const p of [0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.10]) {
    const r = simulate({ rigCount: 500, squirrelCount: 50, repairPctPerPoint: p, mix, days: 360 });
    const netRatio = r.perStrategy.diligent.gross > 0
      ? r.perStrategy.diligent.net / r.perStrategy.diligent.gross : 0;
    const inTarget = r.burnRate >= 0.35 && r.burnRate <= 0.50 && netRatio > 0;
    if (inTarget && !best) best = p;
    console.log('%s %s %s %s %s',
      p.toFixed(3).padEnd(12),
      `${(r.burnRate * 100).toFixed(1)}%`.padStart(12),
      `${(netRatio * 100).toFixed(1)}%`.padStart(12),
      String(r.exploded).padStart(10),
      (inTarget ? 'IN TARGET' : '').padStart(10));
  }

  const chosen = best || 0.06;
  console.log(`\nselected repair price: ${chosen} of gross yield per durability point`);
  console.log(`  -> reviving a rig from 0 costs ${(chosen * 100).toFixed(1)} days of full-rate yield`);
  console.log(`  -> a daily 5-point top-up costs ${((chosen * 5 + REPAIR_SERVICE_FEE) * 100).toFixed(1)}% of that day's full-rate yield`);

  console.log('\n\n=== STRATEGY PAYOFF (360 days, 500 rigs) ===\n');
  const run = simulate({ rigCount: 500, squirrelCount: 50, repairPctPerPoint: chosen, mix, days: 360 });
  console.log('%s %s %s %s %s',
    'strategy'.padEnd(12), 'rigs'.padStart(8), 'net qBTC'.padStart(14),
    'net/rig'.padStart(12), 'survived'.padStart(10));
  for (const [name, s] of Object.entries(run.perStrategy)) {
    console.log('%s %s %s %s %s',
      name.padEnd(12), String(s.count).padStart(8),
      fmt(s.net).padStart(14),
      fmt(s.count ? s.net / s.count : 0).padStart(12),
      `${s.alive}/${s.count}`.padStart(10));
  }

  console.log('\n\n=== SCALE TEST (720 days) ===\n');
  console.log('%s %s %s %s %s',
    'rigs'.padEnd(10), 'cap used'.padStart(12), 'burned'.padStart(12),
    'circulating'.padStart(16), 'burn share'.padStart(12));
  for (const n of [1_000, 5_000, 20_000, 45_000]) {
    const r = simulate({ rigCount: n, squirrelCount: n / 9, repairPctPerPoint: chosen, mix });
    console.log('%s %s %s %s %s',
      fmt(n).padEnd(10),
      `${r.capUsedPct.toFixed(1)}%`.padStart(12),
      fmt(r.burned).padStart(12),
      fmt(r.circulating).padStart(16),
      `${(r.burnRate * 100).toFixed(1)}%`.padStart(12));
  }

  console.log('\n\n=== EMISSION TIMELINE (5,000 rigs) ===\n');
  const t = simulate({ rigCount: 5_000, squirrelCount: 550, repairPctPerPoint: chosen, mix });
  console.log('%s %s %s %s %s',
    'day'.padEnd(8), 'epoch'.padStart(7), 'cap used'.padStart(11),
    'burn share'.padStart(12), 'circulating'.padStart(16));
  for (const row of t.timeline.filter((_, i) => i % 4 === 0)) {
    console.log('%s %s %s %s %s',
      String(row.day).padEnd(8), String(row.epoch).padStart(7),
      `${row.emittedPct.toFixed(1)}%`.padStart(11),
      `${row.burnedPct.toFixed(1)}%`.padStart(12),
      fmt(row.circulating).padStart(16));
  }

  console.log('\n\n=== FINDINGS ===\n');
  const scale = simulate({ rigCount: 45_000, squirrelCount: 5_000, repairPctPerPoint: chosen, mix });
  const checks = [
    ['cap is never exhausted, even at full participation', scale.capUsedPct < 100,
      `${scale.capUsedPct.toFixed(1)}% used after ${DAYS} days at 45,000 rigs`],
    ['burn share lands in the 35-50% design target', run.burnRate >= 0.35 && run.burnRate <= 0.50,
      `${(run.burnRate * 100).toFixed(1)}%`],
    ['attentive play is profitable', run.perStrategy.diligent.net > 0,
      `${fmt(run.perStrategy.diligent.net / run.perStrategy.diligent.count)} qBTC/rig over 360 days`],
    ['diligent beats lazy', run.perStrategy.diligent.net / run.perStrategy.diligent.count
      > run.perStrategy.lazy.net / run.perStrategy.lazy.count,
      'per-rig net'],
    ['neglected rigs earn nothing', run.perStrategy.neglect.net === 0, 'by construction'],
  ];
  for (const [label, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(50)} ${detail}`);
  }
}

main();
