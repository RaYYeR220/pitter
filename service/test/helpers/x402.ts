import { x402Client } from '@x402/core/client'
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import type { FacilitatorClient } from '@x402/core/server'
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from '@x402/core/types'
import { toClientEvmSigner } from '@x402/evm'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import type { Hex, PrivateKeyAccount } from 'viem'

/** A facilitator that approves and settles everything, unless told otherwise. */
export class FakeFacilitator implements FacilitatorClient {
  verified: Array<{ payload: PaymentPayload; requirements: PaymentRequirements }> = []
  settled: Array<{ payload: PaymentPayload; requirements: PaymentRequirements }> = []
  verification: VerifyResponse = { isValid: true }
  onSettle: ((payload: PaymentPayload, requirements: PaymentRequirements) => Promise<SettleResponse>) | undefined
  delayMs = 0

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.verified.push({ payload, requirements })
    return this.verification
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.settled.push({ payload, requirements })
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    if (this.onSettle) return this.onSettle(payload, requirements)
    const authorization = (payload.payload as { authorization: { from: string } }).authorization
    return {
      success: true,
      transaction: `0x${this.settled.length.toString(16).padStart(64, '0')}`,
      network: requirements.network,
      payer: authorization.from,
    }
  }

  async getSupported(): Promise<SupportedResponse> {
    return { kinds: [], extensions: [], signers: {} }
  }
}

/** Reads the requirements out of a 402 response and signs a payment for them, as a paying agent would. */
export async function payFor(response: Response, payer: PrivateKeyAccount): Promise<string> {
  const header = response.headers.get('payment-required')
  if (!header) throw new Error('the response carries no payment requirements')
  return encodePaymentSignatureHeader(await signPayment(decodePaymentRequiredHeader(header), payer))
}

export async function signPayment(required: PaymentRequired, payer: PrivateKeyAccount): Promise<PaymentPayload> {
  const client = registerExactEvmScheme(new x402Client().setSpendControls(false), { signer: toClientEvmSigner(payer) })
  return client.createPaymentPayload(required)
}

export const nonceOf = (payload: PaymentPayload) =>
  (payload.payload as { authorization: { nonce: Hex } }).authorization.nonce
