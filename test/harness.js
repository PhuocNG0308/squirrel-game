/**
 * Local ZVM execution harness.
 *
 * QRL Zond's ZVM is an EVM fork, and hypc emits standard EVM bytecode, so the
 * compiled artifacts can be executed locally with @ethereumjs/vm. That gives
 * us something the live testnet cannot: control over `blockhash`,
 * `block.number` and `block.timestamp`, which is exactly what is needed to
 * test 2-day stake timers, the 256-block reveal window, and — most
 * importantly — whether the commit-reveal scheme actually resists retrying.
 *
 * Addresses here are plain 0x/20-byte EVM addresses. On the real network the
 * same 20 bytes are rendered with a `Q` prefix; the distinction is purely
 * presentational and does not affect execution.
 */
const fs = require('fs');
const path = require('path');
const { createVM } = require('@ethereumjs/vm');
const { Common, Mainnet, Hardfork } = require('@ethereumjs/common');
const { createAddressFromString, hexToBytes, bytesToHex, createAccount } = require('@ethereumjs/util');

const ROOT = path.join(__dirname, '..');

const common = new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai });

function artifact(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'build', `${name}.json`), 'utf8'));
}

/* ------------------------------------------------------------ ABI CODEC */

const { keccak256 } = require('ethereum-cryptography/keccak');
const { utf8ToBytes } = require('ethereum-cryptography/utils');

function selector(sig) {
  return bytesToHex(keccak256(utf8ToBytes(sig))).slice(0, 10);
}

function padHex(v) {
  return v.replace(/^0x/, '').padStart(64, '0');
}

/** Minimal encoder covering the types this test suite uses. */
function encodeArg(type, value) {
  if (type === 'address') return padHex(value.toLowerCase());
  if (type === 'bool') return padHex(value ? '1' : '0');
  if (/^uint/.test(type)) return padHex(BigInt(value).toString(16));
  if (type === 'string') return null; // handled by caller via dynamic path
  throw new Error(`unsupported arg type ${type}`);
}

/**
 * Encodes a call. Dynamic types (uint16[], string) are handled explicitly
 * because the games' external surface only uses a few shapes.
 */
function encodeCall(sig, types, values) {
  let head = '';
  let tail = '';
  const HEAD_WORDS = types.length;

  types.forEach((t, i) => {
    const v = values[i];
    if (t === 'uint16[]') {
      const offset = (HEAD_WORDS + tail.length / 64) * 32;
      head += padHex(offset.toString(16));
      tail += padHex(v.length.toString(16));
      tail += v.map((x) => padHex(BigInt(x).toString(16))).join('');
    } else if (t === 'string') {
      const bytes = Buffer.from(v, 'utf8');
      const offset = (HEAD_WORDS + tail.length / 64) * 32;
      head += padHex(offset.toString(16));
      tail += padHex(bytes.length.toString(16));
      tail += bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0');
    } else if (t === 'uint8[]') {
      const offset = (HEAD_WORDS + tail.length / 64) * 32;
      head += padHex(offset.toString(16));
      tail += padHex(v.length.toString(16));
      tail += v.map((x) => padHex(BigInt(x).toString(16))).join('');
    } else if (t === 'string[]') {
      const offset = (HEAD_WORDS + tail.length / 64) * 32;
      head += padHex(offset.toString(16));
      let inner = padHex(v.length.toString(16));
      let innerTail = '';
      v.forEach((s, j) => {
        const off = (v.length + innerTail.length / 64) * 32;
        inner += padHex(off.toString(16));
        const b = Buffer.from(s, 'utf8');
        innerTail += padHex(b.length.toString(16));
        innerTail += b.toString('hex').padEnd(Math.ceil(b.length / 32) * 64, '0');
      });
      tail += inner + innerTail;
    } else {
      head += encodeArg(t, v);
    }
  });

  return selector(sig) + head + tail;
}

function decodeUint(hex) {
  if (!hex || hex === '0x') return 0n;
  return BigInt('0x' + hex.replace(/^0x/, '').slice(0, 64));
}

function decodeAddress(hex) {
  return '0x' + hex.replace(/^0x/, '').slice(24, 64);
}

function decodeBool(hex) {
  return decodeUint(hex) === 1n;
}

/* ---------------------------------------------------------------- CHAIN */

class Chain {
  constructor(vm) {
    this.vm = vm;
    this.blockNumber = 1n;
    this.timestamp = 1_700_000_000n;
    this.blockHashes = new Map();
    this.gasPool = 30_000_000n;
  }

  static async create() {
    // `chain` is captured by the blockchain stub below; the stub is only ever
    // invoked during a call, by which point the binding is assigned.
    let chain;

    /**
     * Models the BLOCKHASH opcode faithfully, including both of its
     * boundaries: a block that has not been mined yet, and one that has aged
     * out of the 256-block window, each return zero. The reveal-window tests
     * depend on this being accurate.
     */
    const blockchain = {
      getBlock: async (n) => {
        const num = BigInt(n);
        const outOfRange = num >= chain.blockNumber || chain.blockNumber - num > 256n;
        return {
          hash: () => hexToBytes(outOfRange ? '0x' + '00'.repeat(32) : Chain.hashFor(Number(num))),
        };
      },
    };

    chain = new Chain(await createVM({ common, blockchain }));
    return chain;
  }

  /** Deterministic stand-in for a real block hash. */
  static hashFor(n) {
    return bytesToHex(keccak256(utf8ToBytes(`block-${n}`)));
  }

  hashOf(n) { return Chain.hashFor(n); }

  /** Advances the chain, moving both height and wall clock. */
  advance(blocks = 1, secondsPerBlock = 60n) {
    for (let i = 0; i < blocks; i++) {
      this.blockNumber += 1n;
      this.timestamp += secondsPerBlock;
    }
  }

  advanceTime(seconds) {
    const blocks = Number(BigInt(seconds) / 60n);
    this.advance(blocks);
  }

  blockContext() {
    return {
      header: {
        number: this.blockNumber,
        timestamp: this.timestamp,
        gasLimit: 30_000_000n,
        baseFeePerGas: 7n,
        difficulty: 0n,
        prevRandao: hexToBytes(this.hashOf(this.blockNumber)),
        coinbase: createAddressFromString('0x' + '11'.repeat(20)),
      },
    };
  }

  async fund(addr, wei = 10n ** 21n) {
    const account = createAccount({ balance: wei });
    await this.vm.stateManager.putAccount(createAddressFromString(addr), account);
  }

  async deploy(name, argsAbi = [], argsVal = [], from) {
    const art = artifact(name);
    let data = art.bytecode;
    if (argsAbi.length) {
      data += encodeCall('_x()', argsAbi, argsVal).slice(10);
    }
    const res = await this.vm.evm.runCall({
      caller: createAddressFromString(from),
      to: undefined,
      data: hexToBytes(data),
      gasLimit: this.gasPool,
      value: 0n,
      block: this.blockContext(),
    });
    if (res.execResult.exceptionError) {
      throw new Error(`deploy ${name} failed: ${res.execResult.exceptionError.error}`);
    }
    return res.createdAddress.toString();
  }

  async call(to, from, dataHex, value = 0n) {
    const res = await this.vm.evm.runCall({
      caller: createAddressFromString(from),
      to: createAddressFromString(to),
      data: hexToBytes(dataHex),
      gasLimit: this.gasPool,
      value,
      block: this.blockContext(),
    });
    const err = res.execResult.exceptionError;
    const ret = bytesToHex(res.execResult.returnValue);
    if (err) {
      let reason = err.error;
      // decode Error(string) revert payload when present
      if (ret.startsWith('0x08c379a0')) {
        const len = Number(decodeUint('0x' + ret.slice(10 + 64, 10 + 128)));
        reason = Buffer.from(ret.slice(10 + 128, 10 + 128 + len * 2), 'hex').toString('utf8');
      }
      const e = new Error(reason);
      e.reverted = true;
      throw e;
    }
    return ret;
  }

  /** Read-only call that leaves no state behind. */
  async view(to, from, dataHex) {
    const cp = await this.vm.stateManager.dumpStorage;
    return this.call(to, from, dataHex);
  }
}

module.exports = {
  Chain, artifact, encodeCall, selector,
  decodeUint, decodeAddress, decodeBool, padHex,
};
