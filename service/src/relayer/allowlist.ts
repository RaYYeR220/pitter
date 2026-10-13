import { isHex, size, slice, toFunctionSelector, type Address, type Hex } from 'viem'
import { RelayRefused } from './errors'

/**
 * The exact functions the relayer may pay for. Selectors are derived from these signatures alone, so an ABI
 * supplied from elsewhere cannot widen what the relayer is willing to call.
 */
export const RELAYED_FUNCTIONS = {
  buyWithAuthorization:
    'buyWithAuthorization((address,uint256,uint64,uint64,uint128,uint128,uint64,bytes32),bytes,uint256,uint256,uint8,bytes32,bytes32)',
  buy: 'buy((address,uint256,uint64,uint64,uint128,uint128,uint64,bytes32),bytes)',
  settleMany: 'settleMany(uint256[])',
  expire: 'expire(uint256)',
  depositWithAuthorization: 'depositWithAuthorization(uint256,address,uint256,uint256,bytes32,uint8,bytes32,bytes32)',
  transferWithAuthorization:
    'transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)',
  approve: 'approve(address,uint256)',
  drip: 'drip(address)',
  submit: 'submit(bytes)',
} as const

export type RelayedFunction = keyof typeof RELAYED_FUNCTIONS

export const selectorOf = (name: RelayedFunction): Hex => toFunctionSelector(`function ${RELAYED_FUNCTIONS[name]}`)

export interface AllowedCall {
  target: Address
  name: RelayedFunction
  selector: Hex
}

interface Entry extends AllowedCall {
  accepts: ((data: Hex) => boolean) | undefined
}

const entryKey = (target: string, selector: string) => `${target.toLowerCase()}:${selector.toLowerCase()}`

/** A closed set of `(contract, function)` pairs. Anything else is refused before it is simulated or signed. */
export class Allowlist {
  private readonly entries = new Map<string, Entry>()
  private readonly targets = new Set<string>()

  /**
   * Allows `name` on `target`. `accepts`, when given, must also approve the calldata; use it for functions
   * whose arguments decide where money can go.
   */
  allow(target: Address, name: RelayedFunction, accepts?: (data: Hex) => boolean): this {
    const selector = selectorOf(name)
    this.entries.set(entryKey(target, selector), { target, name, selector, accepts })
    this.targets.add(target.toLowerCase())
    return this
  }

  /** Returns the matching entry or throws `RelayRefused`. */
  check(target: Address, data: Hex): AllowedCall {
    if (!this.targets.has(target.toLowerCase())) throw new RelayRefused('target_not_allowed')
    if (!isHex(data, { strict: true }) || size(data) < 4) throw new RelayRefused('selector_not_allowed')
    const entry = this.entries.get(entryKey(target, slice(data, 0, 4)))
    if (!entry) throw new RelayRefused('selector_not_allowed')
    if (entry.accepts && !entry.accepts(data)) throw new RelayRefused('arguments_not_allowed')
    return { target: entry.target, name: entry.name, selector: entry.selector }
  }

  list(): AllowedCall[] {
    return [...this.entries.values()].map(({ target, name, selector }) => ({ target, name, selector }))
  }
}
