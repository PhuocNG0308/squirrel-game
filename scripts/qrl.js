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

/**
 * Largest creation payload the public proxy will accept in one request.
 *
 * The proxy caps a body at 50KB. An ML-DSA-87 signature and public key add
 * ~7.2KB to every transaction, and the bytecode is hex-encoded, so anything
 * past roughly 18KB of creation code has to be delivered in chunks instead.
 */
const DIRECT_DEPLOY_LIMIT = 18_000;

async function deploy(web3, account, name, args = [], gas = 6000000) {
  const art = artifact(name);
  const instance = new web3.qrl.Contract(art.abi);
  await throttle();
  const deployed = await instance
    .deploy({ data: art.bytecode, arguments: args })
    .send({ from: account.address, gas, type: 2 });
  return deployed;
}

/** Creation bytecode plus ABI-encoded constructor arguments, as one hex blob. */
function creationCode(web3, name, args = []) {
  const art = artifact(name);
  const instance = new web3.qrl.Contract(art.abi);
  return instance.deploy({ data: art.bytecode, arguments: args }).encodeABI();
}

function isOversized(web3, name, args = []) {
  return (creationCode(web3, name, args).length - 2) / 2 > DIRECT_DEPLOY_LIMIT;
}

const { keccak256 } = require('ethereum-cryptography/keccak');
const { hexToBytes, bytesToHex } = require('ethereum-cryptography/utils');

/**
 * Deploys a contract that will not fit in one transaction, by uploading its
 * creation bytecode to a ChunkedDeployer and having that run CREATE.
 *
 * Ownership is handed straight back afterwards: CREATE makes the deployer the
 * `msg.sender` the constructor sees, so an Ownable contract would otherwise be
 * stranded under the helper's control.
 *
 * @param transferOwnership set false for contracts that are not Ownable
 */
async function deployChunked(web3, account, deployerAddr, name, args = [], gas = 12000000, opts = {}) {
  // 6KB keeps a single append near 4M gas, well inside a 20M block.
  const { chunkBytes = 6000, transferOwnership = true } = opts;
  const art = artifact(name);
  const code = creationCode(web3, name, args);
  const raw = code.replace(/^0x/, '');
  const expected = '0x' + bytesToHex(keccak256(hexToBytes(code)));

  const deployerAbi = artifact('ChunkedDeployer').abi;
  const helper = new web3.qrl.Contract(deployerAbi, deployerAddr);

  await sendRaw(web3, account, {
    to: deployerAddr,
    data: helper.methods.reset().encodeABI(),
    gas: 500000,
  });

  const perChunk = chunkBytes * 2;
  const chunks = Math.ceil(raw.length / perChunk);
  for (let i = 0; i < chunks; i++) {
    const slice = '0x' + raw.slice(i * perChunk, (i + 1) * perChunk);
    await sendRaw(web3, account, {
      to: deployerAddr,
      data: helper.methods.append(slice).encodeABI(),
      gas: 6000000,
    });
    process.stdout.write(`       chunk ${i + 1}/${chunks}\n`);
  }

  const receipt = await sendRaw(web3, account, {
    to: deployerAddr,
    data: helper.methods.deployBuffered(expected).encodeABI(),
    gas,
  });

  // Match Deployed by its signature, not by topic count: the constructor of
  // an Ownable contract emits OwnershipTransferred first, which also carries
  // three topics and would otherwise be mistaken for the deployment result.
  const DEPLOYED_TOPIC = '0x' + bytesToHex(
    keccak256(Buffer.from('Deployed(address,address,uint256)', 'utf8')),
  );
  const log = (receipt.logs || []).find(
    (l) => l.topics && l.topics[0] && l.topics[0].toLowerCase() === DEPLOYED_TOPIC,
  );
  if (!log) throw new Error(`${name}: chunked deploy emitted no Deployed event`);
  const target = 'Q' + log.topics[2].slice(-40);

  if (transferOwnership) {
    const ownable = new web3.qrl.Contract(art.abi, target);
    await sendRaw(web3, account, {
      to: deployerAddr,
      data: helper.methods.execute(
        target,
        ownable.methods.transferOwnership(account.address).encodeABI(),
      ).encodeABI(),
      gas: 300000,
    });
  }

  return new web3.qrl.Contract(art.abi, target);
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
  creationCode, isOversized, deployChunked, DIRECT_DEPLOY_LIMIT,
  saveDeployment, loadDeployment, ROOT,
};
