/**
 * Turn whatever the operator actually has into a signer — or say precisely
 * what is wrong with it, without ever revealing any part of it.
 *
 * This module exists because of six consecutive failures to get a 64-character
 * key from a phone into an environment variable. `read -s` returned empty on
 * that Termux, the clipboard held 118 characters, a file held 74 bytes of
 * something that was not a key, and the last attempt reached the script as
 * fifteen hex digits — the residue of stripping non-hex characters out of that
 * file, still sitting in the shell from the day before.
 *
 * Every one of those is a shell problem, not a cryptography problem. So the
 * shell comes out of the path: KEY_FILE names a file and the script reads it
 * itself, with no export, no quoting, no command substitution and no chance of
 * a stale variable. What remains is diagnosis, and diagnosis here means saying
 * what a value LOOKS like — its length, its shape, how many words it has —
 * never what it is.
 *
 * A wallet exports its secret in one of two forms, so both are accepted: a
 * 32-byte hex key, or a BIP-39 mnemonic. The mnemonic path derives an address
 * and checks it against the one the contract expects, which is the only
 * question that matters and the only answer safe to print.
 */
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'

/**
 * viem's `mnemonicToAccount` does not validate the mnemonic.
 *
 * It accepts twelve repetitions of the word "zzz" and derives a perfectly real
 * address from them — a function whose name promises a mnemonic and whose
 * behaviour accepts any twelve words. One mistyped word therefore produces a
 * different wallet in silence, and the operator learns of it when the funds are
 * somewhere they cannot reach.
 *
 * BIP-39 has a checksum precisely for this, so it is checked. The wordlist
 * arrives with viem rather than being declared here, so its absence is treated
 * as a fact to report and not a check to skip: without it, a mnemonic is only
 * usable when there is an expected address to derive against.
 */
let bip39 = null
try {
  const [core, english] = await Promise.all([
    import('@scure/bip39'),
    import('@scure/bip39/wordlists/english'),
  ])
  if (typeof core.validateMnemonic === 'function' && Array.isArray(english.wordlist)) {
    bip39 = { validate: (m) => core.validateMnemonic(m, english.wordlist) }
  }
} catch { /* reported below, never skipped silently */ }

/** Whether the BIP-39 checksum can be verified in this installation. */
export const canValidateMnemonic = () => bip39 !== null

/** Expand a leading `~/`, which the shell does not when the value was quoted. */
export function expandHome(path, home = homedir()) {
  if (path === '~') return home
  if (path.startsWith('~/')) return home + path.slice(1)
  return path
}

/** Word counts BIP-39 defines. Anything else is not a mnemonic, whatever it looks like. */
export const MNEMONIC_LENGTHS = new Set([12, 15, 18, 21, 24])

/** How many account indices to try before concluding a mnemonic is the wrong one. */
export const SCAN_DEPTH = 10

/**
 * Describe a secret without disclosing it.
 *
 * Pure, so the description can be tested exhaustively against values that are
 * safe to write down in a test file. Every field here is a count or a boolean;
 * none of them narrows the search space for the value itself in any way that
 * matters, and the alternative — an operator guessing why a key was refused —
 * is what produced six failed attempts.
 */
export function describeSecret(raw) {
  const value = String(raw ?? '').trim()
  const body = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value
  const words = value.split(/\s+/).filter(Boolean)
  return {
    empty: value.length === 0,
    chars: value.length,
    prefixed: value.startsWith('0x') || value.startsWith('0X'),
    hexBody: body.length,
    hexDigits: (value.match(/[0-9a-fA-F]/g) ?? []).length,
    nonHex: [...body].filter((c) => !/[0-9a-fA-F]/.test(c)).length,
    words: words.length,
    // An assignment line pasted whole — PRIVATE_KEY=0x… — is a common enough
    // slip that guessing at "not hex digits" would waste another attempt.
    looksLikeAssignment: /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(value),
    privateKeyShaped: /^[0-9a-fA-F]{64}$/.test(body),
    mnemonicShaped: MNEMONIC_LENGTHS.has(words.length) && words.every((w) => /^[a-z]+$/.test(w)),
    /**
     * A key an editor wrapped, or a scan that returned it in pieces.
     *
     * Deliberately NOT folded into privateKeyShaped: a mnemonic is decided
     * first, so a phrase whose words happened to be all-hex letters can never
     * be reassembled into a key. This only fires when the pieces join to
     * exactly 64 hex characters and nothing else fits.
     */
    wrappedKeyShaped:
      words.length > 1 &&
      !(MNEMONIC_LENGTHS.has(words.length) && words.every((w) => /^[a-z]+$/.test(w))) &&
      /^(0x|0X)?[0-9a-fA-F]{64}$/.test(words.join('')),
  }
}

/**
 * Explain a value that cannot be used, in the operator's terms.
 *
 * Returns lines, not a thrown error, so the caller decides how loudly to say
 * it. `where` names the source — an environment variable or a file path —
 * because the failure that produced this module was a value from the RIGHT
 * shape of command sitting in the WRONG place: without naming the source, "15
 * hex characters" is a fact the operator cannot act on.
 */
export function explainSecret(shape, where) {
  const out = []
  if (shape.empty) {
    out.push(`${where} is empty.`)
    return out
  }
  if (shape.looksLikeAssignment) {
    out.push(`${where} looks like an assignment line, not a value.`)
    out.push('  The whole line was pasted, including the variable name and the "=".')
    return out
  }
  if (shape.words > 1) {
    out.push(`${where} has ${shape.words} whitespace-separated words.`)
    out.push(
      shape.mnemonicShaped
        ? '  That is a valid BIP-39 word count, but it was not accepted — see above.'
        : '  A mnemonic has 12, 15, 18, 21 or 24 lowercase words. A hex key split\n' +
          `  across lines is rejoined automatically, but these ${shape.words} pieces do not\n` +
          `  join to 64 hex characters — they join to ${shape.hexDigits} hex digits out of ` +
          `${shape.chars - shape.words + 1} characters.`,
    )
    return out
  }
  if (shape.nonHex > 0) {
    out.push(`${where} contains ${shape.nonHex} character(s) that are not hex digits.`)
    out.push('  A paste that picked up a prompt, a quote or a line break does this.')
    return out
  }
  out.push(`${where} is ${shape.hexBody} hex characters; a key is 64 (32 bytes).`)
  if (shape.hexBody < 64) {
    out.push(`  ${64 - shape.hexBody} character(s) are missing — a truncated paste or clipboard.`)
    // The exact residue of `tr -cd '[:xdigit:]'` over a file that was never a
    // key. Naming it saves the operator from re-deriving it a second time.
    if (shape.hexBody < 32) {
      out.push('  A value this short is not a truncated key — it is a different value entirely.')
      out.push('  Stripping non-hex characters out of a non-key file produces exactly this.')
    }
  } else {
    out.push('  Two values may have been concatenated, or a stray character came along.')
  }
  return out
}

/**
 * Find the key the operator meant, and say where it came from.
 *
 * KEY_FILE wins over PRIVATE_KEY deliberately. The environment variable is the
 * one that goes stale — it survives across commands, across days, and across
 * the operator's belief that they have replaced it — and a file is a thing you
 * can look at. When both are set, the file is used and the variable is
 * reported, so a stale one is visible rather than silently overriding.
 */
export function findSecret(env = process.env, fs = { existsSync, readFileSync }, home = homedir()) {
  // A tilde survives quoting — KEY_FILE="~/hot.key" reaches us literally, and
  // "no file at ~/hot.key" is a maddening thing to read while looking at it.
  const file = expandHome((env.KEY_FILE ?? '').trim(), home)
  const inline = env.PRIVATE_KEY
  if (file) {
    if (!fs.existsSync(file)) {
      return { ok: false, where: `KEY_FILE (${file})`, reason: 'missing', lines: [`No file at ${file}.`] }
    }
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      return { ok: false, where: `KEY_FILE (${file})`, reason: 'unreadable', lines: [`${file} could not be read: ${err.message}`] }
    }
    return {
      ok: true, where: `KEY_FILE (${file})`, value: text.trim(),
      alsoSet: inline !== undefined && inline !== null && String(inline).trim() !== '' ? 'PRIVATE_KEY' : null,
    }
  }
  if (inline === undefined || inline === null || String(inline).trim() === '') {
    return { ok: false, where: 'PRIVATE_KEY', reason: 'unset', lines: [] }
  }
  return { ok: true, where: 'PRIVATE_KEY', value: String(inline).trim(), alsoSet: null }
}

/**
 * Derive the signer, checking it against the address the contract will accept.
 *
 * A mnemonic does not name one account, it names a tree of them, and wallets
 * disagree about which branch is "the" account. So when index 0 is not the
 * expected address, the first SCAN_DEPTH indices are tried and the matching one
 * is used — reported explicitly, never silently. This cannot select a wrong
 * key: the only thing that makes an index acceptable is deriving the address
 * the deployment record already names.
 *
 * `expected` is optional so a caller with no record to check against still gets
 * an account; then index 0 is used and the address printed for the operator to
 * check by eye.
 */
export function accountFrom(value, expected) {
  const shape = describeSecret(value)
  const want = expected ? String(expected).toLowerCase() : null

  /**
   * A key that derives the wrong address is refused HERE, on every branch.
   *
   * The first version of this function checked `expected` only on the mnemonic
   * branch, because that branch needed it to pick an account index. So a hex
   * key was accepted whatever it derived to, and `EXPECT_ADDRESS` — a name that
   * promises exactly one thing — silently did nothing for the form of key most
   * operators have. The backfill happened to re-check afterwards; the deploy
   * script did not, and had no other check at all.
   */
  const wrongAddress = (account, kind) => ({
    ok: false, kind, shape,
    lines: [
      `This ${kind} does not derive the address it is supposed to.`,
      `  derives   ${account.address}`,
      `  expected  ${expected}`,
    ],
  })

  if (shape.privateKeyShaped) {
    const body = shape.prefixed ? value.trim().slice(2) : value.trim()
    const account = privateKeyToAccount(`0x${body}`)
    if (want && account.address.toLowerCase() !== want) return wrongAddress(account, 'private key')
    return { ok: true, kind: 'private key', account, index: null }
  }

  if (shape.wrappedKeyShaped) {
    const joined = value.trim().split(/\s+/).join('').replace(/^0[xX]/, '')
    const account = privateKeyToAccount(`0x${joined}`)
    const kind = `private key (rejoined from ${shape.words} lines)`
    if (want && account.address.toLowerCase() !== want) return wrongAddress(account, kind)
    return { ok: true, kind, account, index: null }
  }

  if (shape.mnemonicShaped) {
    const phrase = value.trim().split(/\s+/).join(' ')

    if (bip39) {
      if (!bip39.validate(phrase)) {
        return {
          ok: false, kind: 'mnemonic', shape,
          lines: [
            `These ${shape.words} words are not a valid BIP-39 mnemonic.`,
            '  One word is mistyped, out of order, or not in the BIP-39 list.',
            '  The checksum catches this; deriving from them would silently produce',
            '  a different wallet, which is what the checksum exists to prevent.',
          ],
        }
      }
    } else if (!want) {
      return {
        ok: false, kind: 'mnemonic', shape,
        lines: [
          'The BIP-39 wordlist is not installed, so these words cannot be checked,',
          'and no expected address was given to check the result against.',
          '  Nothing would verify that the words are the right ones.',
          '  Run `npm install`, or set EXPECT_ADDRESS to the address they should derive.',
        ],
      }
    }

    let zero
    try {
      zero = mnemonicToAccount(phrase)
    } catch (err) {
      return {
        ok: false, kind: 'mnemonic', shape,
        lines: [
          `The ${shape.words} words could not be turned into a key: ${err.message}`,
        ],
      }
    }
    if (!want || zero.address.toLowerCase() === want) {
      return { ok: true, kind: 'mnemonic', account: zero, index: 0 }
    }
    const tried = [zero.address]
    for (let i = 1; i < SCAN_DEPTH; i++) {
      const a = mnemonicToAccount(phrase, { addressIndex: i })
      if (a.address.toLowerCase() === want) return { ok: true, kind: 'mnemonic', account: a, index: i }
      tried.push(a.address)
    }
    return {
      ok: false, kind: 'mnemonic', shape,
      lines: [
        `This mnemonic does not derive ${expected} in its first ${SCAN_DEPTH} accounts.`,
        `  index 0 gives ${tried[0]}`,
        '  It is a valid mnemonic — it is a mnemonic for a different wallet.',
      ],
    }
  }

  return { ok: false, kind: 'unusable', shape, lines: null }
}
