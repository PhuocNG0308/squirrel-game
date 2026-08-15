/**
 * Vendors the OpenZeppelin sources we depend on into contracts/lib as
 * Hyperion (.hyp) files.
 *
 * Hyperion is a Solidity fork: the language accepts OZ's code as-is, but the
 * compiler rejects `pragma solidity` and the project must be .hyp end to end.
 * Rather than hand-porting ERC721/ERC20 (and losing audited code), this script
 * copies the exact upstream sources and rewrites two things:
 *   1. `pragma solidity ...;`  ->  `pragma hyperion >=0.0.1;`
 *   2. `import "....sol"`      ->  `import "....hyp"`
 *
 * Imports are followed transitively from the entry points below, so the
 * vendored tree is exactly the closure we actually compile.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OZ_ROOT = path.join(ROOT, 'node_modules', '@openzeppelin', 'contracts');
const OUT = path.join(ROOT, 'contracts', 'lib', 'openzeppelin');

const ENTRY = [
  'token/ERC721/extensions/ERC721Enumerable.sol',
  'token/ERC721/IERC721Receiver.sol',
  'token/ERC20/ERC20.sol',
  'access/Ownable.sol',
  'security/Pausable.sol',
  'security/ReentrancyGuard.sol',
  'utils/Strings.sol',
  'utils/Base64.sol',
];

function rewrite(src) {
  return src
    .replace(/pragma\s+solidity[^;]*;/g, 'pragma hyperion >=0.0.1;')
    .replace(/(import\s+[^;]*?)\.sol(["'])/g, '$1.hyp$2')
    // `/// @solidity memory-safe-assembly` is an unknown NatSpec tag to hypc
    // and warns on every occurrence; Hyperion spells it `@hyperion`.
    .replace(/@solidity\s+memory-safe-assembly/g, '@hyperion memory-safe-assembly');
}

/** Collects every `import "..."` path in a source file. */
function importsOf(src) {
  const out = [];
  const re = /import\s+(?:\{[^}]*\}\s+from\s+)?["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

function main() {
  if (!fs.existsSync(OZ_ROOT)) {
    console.error('missing @openzeppelin/contracts — run: npm i @openzeppelin/contracts@4.9.6');
    process.exit(1);
  }

  const seen = new Set();
  const queue = [...ENTRY];

  while (queue.length) {
    const rel = path.normalize(queue.shift()).replace(/\\/g, '/');
    if (seen.has(rel)) continue;
    seen.add(rel);

    const abs = path.join(OZ_ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.error('unresolved OZ import:', rel);
      process.exit(1);
    }
    const src = fs.readFileSync(abs, 'utf8');

    // queue transitive imports, resolved relative to this file
    for (const imp of importsOf(src)) {
      if (imp.startsWith('.')) {
        queue.push(path.posix.join(path.posix.dirname(rel), imp));
      } else {
        queue.push(imp.replace(/^@openzeppelin\/contracts\//, ''));
      }
    }

    const dest = path.join(OUT, rel.replace(/\.sol$/, '.hyp'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, rewrite(src));
  }

  console.log(`vendored ${seen.size} OpenZeppelin sources -> contracts/lib/openzeppelin/`);
  [...seen].sort().forEach((f) => console.log('  ', f.replace(/\.sol$/, '.hyp')));
}

main();
