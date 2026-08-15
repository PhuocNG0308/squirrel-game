/* Smoke test: compile + deploy a trivial contract to QRL Zond testnet v2. */
const fs = require('fs');
const solc = require('solc');
const { Web3 } = require('@theqrl/web3');
const { MLDSA87 } = require('@theqrl/wallet.js');

const SRC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Ping { uint256 public n; function bump() external { n += 1; } }
`;

function env(k) {
  const m = fs.readFileSync(`${__dirname}/../.env`, 'utf8').match(new RegExp(`^${k}="?([^"\\n]+)"?`, 'm'));
  return m && m[1].trim();
}

async function main() {
  const evmVersion = process.argv[2] || 'shanghai';
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'Ping.sol': { content: SRC } },
    settings: {
      evmVersion,
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  })));
  (out.errors || []).forEach((e) => console.log(e.severity, e.formattedMessage.split('\n')[0]));
  const c = out.contracts['Ping.sol'].Ping;
  console.log(`compiled (evm=${evmVersion}) bytecode bytes:`, c.evm.bytecode.object.length / 2);

  const web3 = new Web3(env('QRL_RPC_URL'));
  const acct = web3.qrl.accounts.seedToAccount(
    MLDSA87.newWalletFromMnemonic(env('DEPLOYER_MNEMONIC')).getHexExtendedSeed(),
  );
  web3.qrl.accounts.wallet.add(acct);
  console.log('deployer:', acct.address);
  console.log('chainId :', await web3.qrl.getChainId());
  console.log('balance :', await web3.qrl.getBalance(acct.address));
  console.log('nonce   :', await web3.qrl.getTransactionCount(acct.address));

  const inst = new web3.qrl.Contract(c.abi);
  const deployed = await inst
    .deploy({ data: '0x' + c.evm.bytecode.object })
    .send({ from: acct.address, gas: 400000, type: 2 });
  console.log('DEPLOYED AT:', deployed.options.address);

  const code = await web3.qrl.getCode(deployed.options.address);
  console.log('onchain code bytes:', (code.length - 2) / 2);
  await deployed.methods.bump().send({ from: acct.address, gas: 100000, type: 2 });
  console.log('n after bump:', await deployed.methods.n().call());
}

main().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
