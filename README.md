# Squirrel Game

A faithful [Wolf Game](https://wolf.game) re-implementation written in **Hyperion**
for **QRL Zond (Hyperion) testnet v2** — a post-quantum, EVM-friendly Layer 1.

Quantum Computers mine **qBTC**. Squirrels tax and steal it. Everything —
traits, metadata, yield accounting, theft — is on chain.

## Deployed — QRL Zond testnet v2 (chainId 1337)

| Contract | Address |
|---|---|
| SquirrelGame | `Qfb47c6091d44465E10A576EeAD73c049C339258b` |
| MiningFarm | `QD3301738E761A9Bf4FfD1919B995b274515235d4` |
| QBTC | `QA7B4Ea49212f98fc5E7EA47B1455d1a84619517a` |
| Traits | `Q9161d0A9623A1f25A1f5Ba0300e773b4D75948C7` |

Deployed 2026-08-15 from `Q11cbf00fD1F343E909836F108fC74795d09a5D3a`. All
wiring, economics, and metadata seeding verified on chain via `npm run verify`.

13 tokens minted live through the commit-reveal flow — 11 Quantum Computers
and 2 Squirrels (Tier 2 alpha 7, Tier 1 alpha 6), all resolving their artwork
and attributes correctly.

```bash
npm run mint 5      # commit, wait for the reveal block, reveal, print metadata
```

---

## Role mapping

| Wolf Game | Squirrel Game | Asset |
|---|---|---|
| Sheep | **Quantum Computer** — mines qBTC | `assets/QuantumComputer.png` |
| Wolf | **Squirrel** — taxes and steals, ranked by tier | `assets/Squirrel_Tier{1,2,3}.png` |
| WOOL | **qBTC** | — |
| Barn | **Farm** — where Quantum Computers are staked | — |
| Pack | **Drey** — where Squirrels are staked | — |

90% of mints are Quantum Computers, 10% are Squirrels — unchanged from Wolf Game.

### Squirrel tiers

Squirrels carry an alpha score that weights both their share of the tax pool and
their chance of stealing a mint. Tier 3 is the rarest and strongest.

| Tier | Art | Share of Squirrels | Alpha | `tierIndex` |
|---|---|---|---|---|
| Tier 1 | `Squirrel_Tier1.png` | 60% | 6 | 2 |
| Tier 2 | `Squirrel_Tier2.png` | 30% | 7 | 1 |
| Tier 3 | `Squirrel_Tier3.png` | 10% | 8 | 0 |

Alpha is `MAX_ALPHA - tierIndex` with `MAX_ALPHA = 8`, matching Wolf Game's
convention where a lower index means a stronger animal.

---

## qBTC emission — 21,000,000 hard cap

The cap is Bitcoin-style rather than Wolf Game's 2.4 billion WOOL. To keep the
game *pace* identical, every qBTC quantity is Wolf Game's WOOL figure scaled by

```
SCALE = 21,000,000 / 2,400,000,000 = 7/800 = 0.00875
```

which divides evenly in all cases — no rounding, no fractional wei:

| Quantity | Wolf Game (WOOL) | Squirrel Game (qBTC) |
|---|---:|---:|
| Hard cap | 2,400,000,000 | **21,000,000** |
| Daily rate per miner | 10,000 | **87.5** |
| Mint cost tier 1 | 20,000 | **175** |
| Mint cost tier 2 | 40,000 | **350** |
| Mint cost tier 3 | 80,000 | **700** |
| Total Gen 1 burn | 1,800,000,000 | **15,750,000** |

Because the scaling is uniform, every ratio that defines the game is preserved:

- 2 days of mining still buys the cheapest Gen 1 mint
- Total mint burn is still 75% of the cap
- Emission still spans 240,000 miner-days

Run `npm run economics` to print this table and assert all of it against the
contract sources — the script greps the `.hyp` files, so the report cannot
silently drift from the code.

**Time to reach the cap** (emission only accrues while miners are staked):

| Miners staked | Days to 21M |
|---:|---:|
| 100 | 2,400 |
| 1,000 | 240 |
| 5,000 | 48 |
| 10,000 | 24 |
| 45,000 | 5.3 |

---

## Game rules

**Minting** — 50,000 max supply. Two steps: `commitMint` then `revealMint`
(see [Randomness & security](#randomness--security)).
- Gen 0: 10,000 NFTs at `0.069420 QRL` each
- Gen 1+: 40,000 NFTs bought by burning qBTC (175 / 350 / 700 ladder)
- Max 10 per commit, EOA only, one open commit at a time
- Token IDs and cost are fixed at commit; traits and recipient at reveal
- From Gen 1 on, **10% of mints are stolen** by a randomly chosen staked
  Squirrel, weighted by alpha

**Mining (Quantum Computers in the Farm)**
- Earn 87.5 qBTC/day
- `claimManyFromFarmAndDrey` — claim without unstaking, **20% tax** to the
  Drey, single transaction
- Cannot unstake for **2 days**
- `requestExit` → `executeExit` — unstaking is a coin flip: **50% chance the
  Drey takes the entire pending yield**

**Taxing (Squirrels in the Drey)**
- Earn a share of all tax proportional to alpha
- Squirrels are never at risk while staked
- Higher tier = larger share and better steal odds

---

## Architecture

| Contract | Purpose |
|---|---|
| `contracts/QBTC.hyp` | ERC-20 yield token. No premine; only whitelisted controllers mint/burn. |
| `contracts/SquirrelGame.hyp` | ERC-721. Minting, trait rolling, theft-on-mint. |
| `contracts/MiningFarm.hyp` | Staking. Farm (miners) + Drey (squirrels), tax accounting. |
| `contracts/Traits.hyp` | On-chain metadata; base64 `data:` tokenURI. |
| `contracts/lib/CommitReveal.hyp` | Future-block randomness. Documents the attack it prevents. |
| `contracts/lib/openzeppelin/` | Vendored OpenZeppelin 4.9.6, converted to Hyperion. |
| `contracts/interfaces/` | Cross-contract interfaces. |

### Metadata

`tokenURI` returns a fully on-chain base64 JSON document. Wolf Game composited
PNG layers on chain; Squirrel Game has one finished artwork per (type, tier), so
the `image` field points at the repo while **every attribute is still derived on
chain** from the token's stored traits:

```
https://raw.githubusercontent.com/PhuocNG0308/squirrel-game/main/assets/Squirrel_Tier3.png
```

Trait tables live in `scripts/gen-traits.js` and are compiled into Walker alias
tables (the same technique Wolf Game used). Running `npm run traits` prints the
realised probability of every trait value — all land within 0.12pp of target.

---

## Toolchain notes (QRL is not stock EVM)

These caught me out during bring-up and are worth knowing before you review:

1. **The language is Hyperion, not Solidity.** Sources are `.hyp` with
   `pragma hyperion >=0.0.1;`. The compiler is `@theqrl/hypc`, and it rejects
   `language: "Solidity"` outright.
2. **Compiler output is under `zvm`, not `evm`** — Zond Virtual Machine.
   `outputSelection` must ask for `zvm.bytecode.object`.
3. **OpenZeppelin works unmodified** apart from the pragma and import
   extensions. `scripts/vendor-oz.js` performs that rewrite so we keep audited
   code rather than hand-porting ERC-721.
4. **Addresses are `Q`-prefixed**, 20 bytes (e.g. `Q11cbf00f…`).
5. **Signatures are ML-DSA-87 (FIPS 204)**, not secp256k1. There is no ECDSA
   private key; accounts derive from a 34-word mnemonic → 51-byte extended seed.
6. **The public RPC exposes a `qrl_*` namespace**, not `eth_*`, and whitelists
   only a subset of methods. `@theqrl/web3@0.5.0` is the release line that
   matches both the namespace and the 20-byte address format — v1.x produces
   64-byte addresses for a newer network and will not work here.
7. **Writes are rate-limited to 10/min per IP**, so the deploy script throttles
   to 7s between transactions and batches all 63 trait values into one call.

Verified live: chainId **1337**, gas price ~1 Gwei, `shanghai`-level opcodes
(PUSH0) supported.

---

## Usage

```bash
npm install

npm run build       # vendor OZ -> generate traits -> compile
npm run economics   # print + assert the tokenomics (no network access)
npm test            # run the contracts in a local EVM (37 tests)

npm run check       # all three of the above
```

Deployment is deliberately gated:

```bash
npm run deploy -- --confirm    # deploys and wires all four contracts
npm run verify                 # reads back on-chain state, sends nothing
```

`deploy.js` writes addresses to `deployments/testnet.json`; `verify.js` reads
that file and checks code presence, wiring, economics, and metadata seeding.

---

## Contract sizes

| Contract | Init | Runtime | EIP-170 limit |
|---|---:|---:|---:|
| QBTC | 4,140 | 3,552 | 24,576 |
| SquirrelGame | 17,582 | 14,713 | 24,576 |
| MiningFarm | 12,460 | 12,147 | 24,576 |
| Traits | 9,196 | 7,972 | 24,576 |

---

## Randomness & security

Wolf Game derived randomness from `blockhash(block.number - 1)`,
`block.timestamp` and `tx.origin` — all readable inside the transaction that
consumes them. That is what got it exploited in production:

```solidity
contract Attacker {
    function tryMint() external {
        game.mint{value: price}(1, false);
        require(gotSquirrel(), "bad roll");   // revert, pay nothing, retry
    }
}
```

The attacker inspects the outcome atomically and reverts when it is
unfavourable. **No entropy source fixes this** — not `block.prevrandao`, not a
better hash. The flaw is that the result is *observable before it is binding*.

### The fix: commit-reveal against a future block

Every random action is split in two:

1. **commit** — the player pays and locks in their intent. The contract records
   a `revealBlock` one block in the future. Nothing is decided yet.
2. **reveal** — once that block exists, the seed is derived from **its** hash.

On proof-of-stake a block hash commits to that block's `prevRandao`, so the
beacon chain's RANDAO output is the real entropy source here — read from a
block that did not exist when the player committed.

The property that matters: **the seed is fixed the moment `revealBlock` is
mined**. Reverting the reveal and retrying yields an identical result, so
there is nothing to grind. Reveal is also permissionless — anyone may reveal
anyone's commit — so refusing to reveal a bad outcome gains nothing.

Deliberately excluded from the seed, because the revealer chooses *when* to
reveal and could otherwise grind on them: `block.prevrandao` and
`blockhash(block.number - 1)` at reveal time, `block.timestamp`, and the
reveal caller's address.

| Action | Random? | Flow |
|---|---|---|
| Mint | yes — traits + 10% theft | `commitMint` → `revealMint` |
| Claim without unstaking | no — flat 20% tax | single transaction |
| Unstake | yes — 50/50 yield steal | `requestExit` → `executeExit` |

Only the genuinely random actions pay the two-transaction cost.

### Verified, not just asserted

`npm test` executes the compiled ZVM bytecode in a local EVM
(`@ethereumjs/vm`), which allows controlling `block.number`, `blockhash` and
`block.timestamp` — impossible against the live testnet. 37 tests cover the
retry attack, both reveal-window boundaries, the 2-day timer, trait
distributions, yield maths, and metadata. The headline assertion is that the
same commit produces the same outcome regardless of *when* or *by whom* it is
revealed.

### Residual risks — read before mainnet

- **Stalling past the reveal window.** `blockhash` only covers 256 blocks
  (~4.3 h at 60 s). A commit left unrevealed must be re-anchored to a new
  block, which is one re-roll. Permissionless reveal plus any keeper makes
  this impractical, and hours of delay per attempt is uneconomic against a
  10% / 50% edge — but it is not zero.
- **Proposer grinding.** Whoever proposes `revealBlock` can reorder their
  block to bias its hash. This needs control of that specific slot and is far
  weaker than open user-side retrying. A VRF would close it; QRL Zond has no
  native VRF today.
- **`tx.origin == msg.sender`** gates minting to EOAs. This is the safe use of
  `tx.origin` (a caller check, never authorisation).
- **The deployer mnemonic was shared in plaintext** during setup. It lives in
  `.env`, gitignored, and must never be committed. Treat that key as
  compromised; testnet only.
- Contracts are unaudited.

---

## License

MIT
