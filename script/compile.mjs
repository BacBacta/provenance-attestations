/**
 * Compile with solc standard JSON and write everything an explorer verification
 * needs: ABI, creation bytecode, and the exact standard input. No framework —
 * the contract is a single self-contained file, and keeping the toolchain this
 * small is part of the audit surface being small.
 */
import solc from 'solc'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const SOURCE = 'contracts/ProvenanceAttestations.sol'

const input = {
  language: 'Solidity',
  sources: { [SOURCE]: { content: readFileSync(SOURCE, 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 10_000 },
    // 'paris' emits no PUSH0, so the bytecode runs identically on every EVM
    // chain regardless of Shanghai support. Celo supports newer opcodes, but
    // portability costs almost nothing here and removes a whole class of doubt.
    evmVersion: 'paris',
    metadata: { bytecodeHash: 'ipfs' },
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] },
    },
  },
}

const out = JSON.parse(solc.compile(JSON.stringify(input)))

const fatal = (out.errors ?? []).filter((e) => e.severity === 'error')
for (const e of out.errors ?? []) console.error(e.formattedMessage)
if (fatal.length) process.exit(1)

const c = out.contracts[SOURCE]['ProvenanceAttestations']
mkdirSync('out', { recursive: true })
writeFileSync('out/ProvenanceAttestations.abi.json', JSON.stringify(c.abi, null, 2))
writeFileSync('out/ProvenanceAttestations.bin', c.evm.bytecode.object)
writeFileSync('out/ProvenanceAttestations.deployed.bin', c.evm.deployedBytecode.object)
writeFileSync('out/standard-input.json', JSON.stringify(input, null, 2))
writeFileSync('out/metadata.json', c.metadata)

console.log('compiled: ProvenanceAttestations')
console.log('  solc      ', JSON.parse(c.metadata).compiler.version)
console.log('  bytecode  ', c.evm.bytecode.object.length / 2, 'bytes')
console.log('  deployed  ', c.evm.deployedBytecode.object.length / 2, 'bytes')
