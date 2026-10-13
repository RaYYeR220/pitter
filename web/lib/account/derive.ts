import { HDKey } from '@scure/bip32'
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

/** The standard path of the first EVM account of a seed. */
export const ACCOUNT_PATH = "m/44'/60'/0'/0/0"

/**
 * Derives the account's private key from the passkey's PRF output.
 *
 * The 32 bytes are read as the entropy of a 24-word BIP-39 phrase, and the key is the first EVM account of
 * that phrase. The same passkey therefore always yields the same account, on any device, and the phrase is a
 * standard way out should the account ever have to move.
 *
 * @returns 32 bytes owned by the caller, who must zero them once a signing session holds its own copy.
 */
export function deriveAccountKey(prfOutput: Uint8Array): Uint8Array {
  if (prfOutput.length !== 32) throw new RangeError('expected a 32-byte PRF output')
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist))
  try {
    const node = HDKey.fromMasterSeed(seed).derive(ACCOUNT_PATH)
    if (!node.privateKey) throw new Error('the derivation produced no key')
    const key = Uint8Array.from(node.privateKey)
    node.wipePrivateData()
    return key
  } finally {
    seed.fill(0)
  }
}
