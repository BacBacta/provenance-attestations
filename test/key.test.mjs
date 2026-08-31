/**
 * The key path, tested against the six real failures that produced it.
 *
 * Every value below is a public test vector — the BIP-39 all-`abandon`
 * mnemonic and a key of repeated 0x11 bytes — so the file discloses nothing.
 * The point of these tests is not cryptography, which viem already tests; it
 * is the DIAGNOSIS: an operator holding the right key must be told which of
 * the six things went wrong, and an operator holding the wrong one must never
 * reach a paid transaction.
 */
import assert from 'node:assert/strict'
import {
  describeSecret, explainSecret, findSecret, accountFrom, expandHome, SCAN_DEPTH,
  canValidateMnemonic,
} from '../script/key.mjs'

let passed = 0
function check(name, fn) {
  try { fn(); passed++; console.log(`  \u2713 ${name}`) }
  catch (e) { console.error(`  \u2717 ${name}`); throw e }
}

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const M0 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const M3 = '0xF3f50213C1d2e255e4B2bAD430F8A38EEF8D718E'
const HEX = '11'.repeat(32)
const HEX_ADDR = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'

const fsWith = (files) => ({
  existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
  readFileSync: (p) => {
    if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error('ENOENT')
    if (files[p] === null) throw new Error('EACCES: permission denied')
    return files[p]
  },
})

check('a 64-character hex key is recognised, with or without 0x', () => {
  for (const v of [HEX, `0x${HEX}`, `  ${HEX}\n`]) {
    const s = describeSecret(v)
    assert.ok(s.privateKeyShaped, `${v.slice(0, 4)}… should be key-shaped`)
    assert.equal(s.hexBody, 64)
  }
})

check('the fifteen-hex-character run is named for what it was', () => {
  // The exact value that reached the script: the residue of stripping non-hex
  // characters out of a file that was never a key. Calling it "truncated"
  // sends the operator looking for the missing 49 characters of something that
  // does not exist.
  const s = describeSecret('a1b2c3d4e5f0123')
  assert.equal(s.hexBody, 15)
  assert.ok(!s.privateKeyShaped)
  const lines = explainSecret(s, 'PRIVATE_KEY').join('\n')
  assert.ok(lines.includes('15 hex characters'), lines)
  assert.ok(lines.includes('49 character(s) are missing'), lines)
  assert.ok(lines.includes('not a truncated key'), lines)
  assert.ok(lines.includes('PRIVATE_KEY'), 'the source must be named, or the fact is unactionable')
})

check('an over-long value is not described as truncated', () => {
  const lines = explainSecret(describeSecret(HEX + 'ab'), 'KEY_FILE (~/hot.key)').join('\n')
  assert.ok(lines.includes('concatenated'), lines)
  assert.ok(!lines.includes('missing'), lines)
})

check('a pasted assignment line is diagnosed as one', () => {
  const lines = explainSecret(describeSecret(`PRIVATE_KEY=0x${HEX}`), 'KEY_FILE (~/hot.key)').join('\n')
  assert.ok(lines.includes('assignment line'), lines)
})

check('a mnemonic is not reported as bad hex', () => {
  // The 74-byte file that held 15 hex characters had this shape. Reporting it
  // as "not hex digits" is true and useless; reporting the word count points
  // at the actual question, which is whether it is a seed phrase.
  const s = describeSecret(MNEMONIC)
  assert.ok(s.mnemonicShaped)
  assert.equal(s.words, 12)
  const lines = explainSecret(describeSecret('abandon abandon about'), 'KEY_FILE (~/k)').join('\n')
  assert.ok(lines.includes('3 whitespace-separated words'), lines)
  assert.ok(lines.includes('12, 15, 18, 21 or 24'), lines)
})

check('a key an editor wrapped across lines is rejoined', () => {
  // A realistic sixth attempt: the key reaches the file correctly but an editor
  // or a QR scan hard-wraps it. Refusing that as "not hex digits" would send
  // the operator back to the wallet for a key that was already in their hand.
  for (const sep of ['\n', '\r\n', ' ', '\n  ']) {
    const wrapped = HEX.slice(0, 32) + sep + HEX.slice(32)
    const s2 = describeSecret(wrapped)
    assert.ok(s2.wrappedKeyShaped, `separator ${JSON.stringify(sep)}`)
    const r = accountFrom(wrapped, HEX_ADDR)
    assert.ok(r.ok, JSON.stringify(r.lines))
    assert.equal(r.account.address, HEX_ADDR)
    assert.ok(r.kind.includes('rejoined'), r.kind)
  }
})

check('a mnemonic is never reassembled into a key', () => {
  // The rejoining rule must not be able to eat a seed phrase. A mnemonic is
  // decided first, so even a phrase of all-hex-letter words stays a mnemonic.
  assert.equal(describeSecret(MNEMONIC).wrappedKeyShaped, false)
  const r = accountFrom(MNEMONIC, M0)
  assert.equal(r.kind, 'mnemonic')
})

check('pieces that do not join to a key are still refused', () => {
  const r = accountFrom('dead beef', HEX_ADDR)
  assert.ok(!r.ok)
  const lines = explainSecret(describeSecret('dead beef'), 'KEY_FILE (~/k)').join('\n')
  assert.ok(lines.includes('2 whitespace-separated words'), lines)
  assert.ok(lines.includes('rejoined automatically'), lines)
})

check('a hex key derives its address', () => {
  const r = accountFrom(HEX)
  assert.ok(r.ok)
  assert.equal(r.kind, 'private key')
  assert.equal(r.account.address, HEX_ADDR)
})

check('a hex key that derives the wrong address is refused on its own branch', () => {
  // Regression: `expected` was honoured only for mnemonics, so EXPECT_ADDRESS
  // silently did nothing for the commonest form of key. The backfill re-checked
  // afterwards and survived it; the deploy script had no other check at all.
  const r = accountFrom(HEX, '0x' + 'de'.repeat(20))
  assert.ok(!r.ok, 'a hex key deriving the wrong address must be refused')
  const lines = r.lines.join('\n')
  assert.ok(lines.includes(HEX_ADDR), lines)
  assert.ok(lines.includes('de'.repeat(20)), lines)
})

check('a rejoined key is checked against the expected address too', () => {
  const wrapped = HEX.slice(0, 32) + '\n' + HEX.slice(32)
  assert.ok(!accountFrom(wrapped, '0x' + 'de'.repeat(20)).ok)
  assert.ok(accountFrom(wrapped, HEX_ADDR).ok)
})

check('a mnemonic derives account 0 when that is the expected address', () => {
  const r = accountFrom(MNEMONIC, M0)
  assert.ok(r.ok)
  assert.equal(r.kind, 'mnemonic')
  assert.equal(r.index, 0)
  assert.equal(r.account.address, M0)
})

check('a mnemonic whose wallet used another account index is found, and the index reported', () => {
  const r = accountFrom(MNEMONIC, M3)
  assert.ok(r.ok, JSON.stringify(r.lines))
  assert.equal(r.index, 3)
  assert.equal(r.account.address, M3)
})

check('a mnemonic for a different wallet is refused, not silently accepted at index 0', () => {
  const r = accountFrom(MNEMONIC, '0x' + 'de'.repeat(20))
  assert.ok(!r.ok)
  const lines = r.lines.join('\n')
  assert.ok(lines.includes(`first ${SCAN_DEPTH} accounts`), lines)
  assert.ok(lines.includes(M0), 'index 0 must be shown so the operator can recognise the wrong wallet')
})

check('twelve words that are not in the wordlist are refused', () => {
  // viem's mnemonicToAccount derives a real address from these. Without the
  // checksum check below, this test would pass an unusable wallet through.
  const r = accountFrom(Array(12).fill('zzz').join(' '), '0x' + 'de'.repeat(20))
  assert.ok(!r.ok)
  assert.ok(r.lines.join(' ').includes('not a valid BIP-39 mnemonic'), r.lines.join(' '))
})

check('a real word in the wrong place fails the checksum', () => {
  // Every word here is in the BIP-39 list, so a wordlist-membership check would
  // wave it through; only the checksum catches it. This is the realistic typo:
  // the operator transcribed eleven words correctly and the twelfth wrongly.
  const typo = MNEMONIC.replace(/about$/, 'abandon')
  assert.equal(typo.split(' ').length, 12)
  assert.ok(canValidateMnemonic(), 'the checksum must actually be available here')
  const r = accountFrom(typo, M0)
  assert.ok(!r.ok)
  assert.ok(r.lines.join(' ').includes('checksum'), r.lines.join(' '))
})

check('a valid mnemonic in the wrong ORDER is refused, not silently used', () => {
  const reordered = MNEMONIC.split(' ').reverse().join(' ')
  const r = accountFrom(reordered, M0)
  assert.ok(!r.ok)
})

check('no expected address means index 0 and no scan', () => {
  const r = accountFrom(MNEMONIC)
  assert.ok(r.ok)
  assert.equal(r.account.address, M0)
})

check('KEY_FILE beats a stale PRIVATE_KEY, and says so', () => {
  // The regression this whole module exists for: the variable held fifteen
  // characters from the day before while the real key sat in a file.
  const found = findSecret(
    { KEY_FILE: '/k', PRIVATE_KEY: 'a1b2c3d4e5f0123' },
    fsWith({ '/k': `${HEX}\n` }),
  )
  assert.ok(found.ok)
  assert.equal(found.value, HEX)
  assert.equal(found.alsoSet, 'PRIVATE_KEY')
  assert.ok(found.where.includes('/k'))
})

check('a missing KEY_FILE does not silently fall back to the variable', () => {
  // Falling back would resurrect exactly the stale value the operator was
  // trying to escape, and the run would fail with the same message as before.
  const found = findSecret({ KEY_FILE: '/nope', PRIVATE_KEY: HEX }, fsWith({}))
  assert.ok(!found.ok)
  assert.equal(found.reason, 'missing')
  assert.ok(found.lines.join(' ').includes('/nope'))
})

check('an unreadable KEY_FILE reports the reason', () => {
  const found = findSecret({ KEY_FILE: '/k' }, fsWith({ '/k': null }))
  assert.ok(!found.ok)
  assert.equal(found.reason, 'unreadable')
  assert.ok(found.lines.join(' ').includes('permission denied'))
})

check('a quoted tilde is expanded, because the shell did not', () => {
  assert.equal(expandHome('~/hot.key', '/home/u'), '/home/u/hot.key')
  assert.equal(expandHome('~', '/home/u'), '/home/u')
  assert.equal(expandHome('/abs/hot.key', '/home/u'), '/abs/hot.key')
  assert.equal(expandHome('~notauser/x', '/home/u'), '~notauser/x')
  const found = findSecret({ KEY_FILE: '~/hot.key' }, fsWith({ '/home/u/hot.key': HEX }), '/home/u')
  assert.ok(found.ok)
  assert.equal(found.value, HEX)
})

check('a whitespace-only variable counts as unset, not as an empty key', () => {
  const found = findSecret({ PRIVATE_KEY: '   \n' }, fsWith({}))
  assert.ok(!found.ok)
  assert.equal(found.reason, 'unset')
})

check('a mnemonic file with newlines between words still works', () => {
  const found = findSecret({ KEY_FILE: '/k' }, fsWith({ '/k': MNEMONIC.split(' ').join('\n') + '\n' }))
  assert.ok(found.ok)
  const r = accountFrom(found.value, M0)
  assert.ok(r.ok, JSON.stringify(r.lines))
  assert.equal(r.account.address, M0)
})

check('nothing in a diagnosis discloses the value', () => {
  // A description that leaked even a prefix would turn a support paste into a
  // key disclosure. Every field is a count or a boolean; assert that directly.
  const secret = 'deadbeef'.repeat(8)
  const s = describeSecret(secret)
  const dumped = JSON.stringify(s) + explainSecret(describeSecret('a1b2c3'), 'PRIVATE_KEY').join(' ')
  assert.ok(!dumped.includes('deadbeef'), dumped)
  assert.ok(!dumped.includes('a1b2c3'), dumped)
  for (const v of Object.values(s)) {
    assert.ok(typeof v === 'number' || typeof v === 'boolean', `leaked a ${typeof v}`)
  }
})

console.log(`\n${passed} passed\n`)
