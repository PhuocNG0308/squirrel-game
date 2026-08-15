/**
 * Generates the Walker alias tables used by SquirrelGame.selectTrait().
 *
 * Wolf Game hardcodes `rarities[]` / `aliases[]` per trait slot; this script
 * derives the same structures from readable probability weights so the tables
 * stay auditable. Emits Solidity for contracts/SquirrelGame.sol and the JSON
 * name tables consumed by contracts/Traits.sol.
 */
const fs = require('fs');

// slot => { name, options: [[label, weight], ...] }
// Slots 0-8 are Quantum Computers, 9-17 are Squirrels (shift of 9), exactly
// mirroring Wolf Game's 18-slot layout.
const T = [
  ['Chassis',   [['Carbon', 30], ['Titanium', 30], ['Obsidian', 20], ['Cryo-White', 15], ['Gold-Plated', 5]]],
  ['Cooling',   [['Air-Cooled', 45], ['Liquid Nitrogen', 30], ['Helium-3', 20], ['Zero-Point', 5]]],
  ['Antenna',   [['None', 40], ['Dipole', 30], ['Phased Array', 22], ['Quantum Link', 8]]],
  ['Display',   [['Mono CRT', 40], ['LED Matrix', 32], ['Holo-Panel', 20], ['Neural HUD', 8]]],
  ['Power Core',[['Fusion Cell', 55], ['Thorium Core', 33], ['Antimatter', 12]]],
  ['Interface', [['Punch Card', 35], ['Keyboard', 35], ['Voice', 22], ['Thought', 8]]],
  ['Shielding', [['None', 100]]],
  ['Mounting',  [['Steel Rack', 55], ['Mag-Lev', 32], ['Vacuum Cradle', 13]]],
  ['Unused',    [['None', 100]]],

  ['Fur',       [['Rust', 35], ['Amber', 28], ['Ash', 20], ['Snow', 12], ['Void', 5]]],
  ['Headgear',  [['None', 40], ['Visor Rig', 30], ['Hood', 22], ['Crown', 8]]],
  ['Ears',      [['Tufted', 45], ['Notched', 25], ['Pierced', 20], ['Augmented', 10]]],
  ['Optics',    [['Green Lens', 50], ['Violet Lens', 35], ['Gold Lens', 15]]],
  ['Nose',      [['Standard', 60], ['Scarred', 28], ['Chrome', 12]]],
  ['Mouth',     [['Neutral', 40], ['Smirk', 30], ['Snarl', 22], ['Fanged', 8]]],
  ['Gear',      [['None', 38], ['Bandolier', 30], ['Katana Rig', 24], ['Royal Mantle', 8]]],
  ['Paws',      [['Bare', 40], ['Wrapped', 30], ['Armored', 22], ['Gilded', 8]]],
  // tierIndex: alpha = MAX_ALPHA - tierIndex, so index 0 is the rarest/strongest.
  ['Tier',      [['Tier 3', 10], ['Tier 2', 30], ['Tier 1', 60]]],
];

/** Walker's alias method, quantised to the uint8 domain selectTrait() uses. */
function alias(weights) {
  const n = weights.length;
  const total = weights.reduce((a, b) => a + b, 0);
  const scaled = weights.map((w) => (w / total) * n);
  const prob = new Array(n).fill(0);
  const aliasOf = new Array(n).fill(0);
  const small = [];
  const large = [];
  scaled.forEach((p, i) => (p < 1 ? small : large).push(i));

  while (small.length && large.length) {
    const s = small.pop();
    const l = large.pop();
    prob[s] = scaled[s];
    aliasOf[s] = l;
    scaled[l] = scaled[l] - (1 - scaled[s]);
    (scaled[l] < 1 ? small : large).push(l);
  }
  // Leftovers are probability-1 buckets that alias to themselves.
  [...small, ...large].forEach((i) => { prob[i] = 1; aliasOf[i] = i; });

  // selectTrait keeps `trait` when (seed >> 8) < rarities[trait], where the
  // left side spans 0..255. Rounding up keeps quantisation error non-negative
  // so a bucket is never starved below its intended weight.
  const rarities = prob.map((p) => Math.min(255, Math.ceil(p * 255)));
  return { rarities, aliases: aliasOf };
}

/** Exact realised probabilities under selectTrait's two-step draw. */
function realised(rarities, aliases) {
  const n = rarities.length;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const keep = rarities[i] / 256;
    out[i] += keep / n;
    out[aliases[i]] += (1 - keep) / n;
  }
  return out;
}

const rarityLines = [];
const aliasLines = [];
const names = [];

T.forEach(([name, options], slot) => {
  const { rarities, aliases } = alias(options.map((o) => o[1]));
  rarityLines.push(`        rarities[${slot}] = [${rarities.join(', ')}];`);
  aliasLines.push(`        aliases[${slot}] = [${aliases.join(', ')}];`);
  names.push({ slot, trait: name, values: options.map((o) => o[0]) });

  const got = realised(rarities, aliases);
  const want = options.map((o) => o[1] / options.reduce((a, b) => a + b[1], 0));
  const drift = Math.max(...got.map((g, i) => Math.abs(g - want[i])));
  console.log(
    `slot ${String(slot).padStart(2)} ${name.padEnd(11)} ` +
    `target=[${want.map((w) => (w * 100).toFixed(1)).join(' ')}] ` +
    `actual=[${got.map((g) => (g * 100).toFixed(1)).join(' ')}] ` +
    `maxdrift=${(drift * 100).toFixed(2)}pp`,
  );
});

const outDir = `${__dirname}/../build`;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(`${outDir}/trait-tables.hyp.txt`,
  `${rarityLines.join('\n')}\n\n${aliasLines.join('\n')}\n`);
fs.writeFileSync(`${outDir}/trait-names.json`, JSON.stringify(names, null, 2));
console.log('\nwrote build/trait-tables.hyp.txt and build/trait-names.json');
