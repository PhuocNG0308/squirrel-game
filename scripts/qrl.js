/**
 * QRL Zond (Hyperion) connection helpers.
 *
 * Notes on this chain that differ from a stock EVM setup:
 *  - Addresses are 20 bytes but rendered with a `Q` prefix, not `0x`.
 *  - Signatures are ML-DSA-87 (post-quantum), not secp256k1. There is no
 *    private key in the ECDSA sense; accounts come from a 34-word mnemonic
 *    -> 51-byte extended seed.
 *  - The public RPC proxy exposes a `qrl_*` namespace instead of `eth_*`, and
 *    only whitelists a subset of methods. @theqrl/web3@0.5.0 is the release
 *    line that matches both the namespace and the 20-byte address format.
 *  - Writes are rate-limited to 10/min per IP, hence `sendThrottled`.
 */
const fs = require('fs');
const path = require('path');
const { Web3 } = require('@theqrl/web3');
const { MLDSA87 } = require('@theqrl/wallet.js');

const ROOT = path.join(__dirname, '..');

function loadEnv() {
  const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const env = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
  }
  return env;
}

function connect() {
  const env = loadEnv();
  if (!env.DEPLOYER_MNEMONIC) throw new Error('DEPLOYER_MNEMONIC missing from .env');

  const web3 = new Web3(env.QRL_RPC_URL);
  const wallet = MLDSA87.newWalletFromMnemonic(env.DEPLOYER_MNEMONIC);
  const account = web3.qrl.accounts.seedToAccount(wallet.getHexExtendedSeed());
  web3.qrl.accounts.wallet.add(account);

  return { web3, account, env };
}

function artifact(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'build', `${name}.json`), 'utf8'));
}

/** Write rate limit is 10/min; 7s spacing keeps a safety margin. */
const WRITE_SPACING_MS = 7000;
let lastWrite = 0;

async function throttle() {
  const wait = lastWrite + WRITE_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastWrite = Date.now();
}

/** Sends a prepared contract call, respecting the proxy's write rate limit. */
async function send(tx, from, gas) {
  await throttle();
  return tx.send({ from, gas, type: 2 });
}

/**
 * Signs locally and submits via qrl_sendRawTransaction.
 *
 * Contract objects returned by `.deploy().send()` are bound to the local
 * wallet and can sign themselves, but one built as `new Contract(abi, address)`
 * is not — web3 falls back to `qrl_sendTransaction`, asking the node to sign,
 * which the public proxy does not allow. Signing explicitly avoids depending
 * on that distinction.
 */
async function sendRaw(web3, account, { to, data, value = 0n, gas }) {
  await throttle();
  const [nonce, chainId, block] = await Promise.all([
    web3.qrl.getTransactionCount(account.address, 'latest'),
    web3.qrl.getChainId(),
    web3.qrl.getBlock('latest'),
  ]);

  const baseFee = BigInt(block.baseFeePerGas || 7);
  const tip = 1_000_000_000n; // 1 Gwei, matches the network's reported gas price

  const signed = await account.signTransaction({
    to,
    data,
    value: value.toString(),
    gas,
    nonce: Number(nonce),
    chainId: Number(chainId),
    type: 2,
    maxPriorityFeePerGas: tip.toString(),
    maxFeePerGas: (baseFee * 2n + tip).toString(),
  });

  return web3.qrl.sendSignedTransaction(signed.rawTransaction);
}

async function deploy(web3, account, name, args = [], gas = 6000000) {
  const art = artifact(name);
  const instance = new web3.qrl.Contract(art.abi);
  await throttle();
  const deployed = await instance
    .deploy({ data: art.bytecode, arguments: args })
    .send({ from: account.address, gas, type: 2 });
  return deployed;
}

function saveDeployment(data) {
  const dir = path.join(ROOT, 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'testnet.json'), JSON.stringify(data, null, 2));
}

function loadDeployment() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', 'testnet.json'), 'utf8'));
}

module.exports = {
  connect, artifact, deploy, send, sendRaw, throttle,
  saveDeployment, loadDeployment, ROOT,
};
