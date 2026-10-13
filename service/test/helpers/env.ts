import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

const randomAddress = () => privateKeyToAddress(generatePrivateKey());

/** A complete, valid environment for a test network, with freshly generated keys and addresses. */
export function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    CHAIN_ID: "10143",
    RPC_URL: "https://rpc.example.test/v1/secret-api-key",
    TOKEN_ADDRESS: randomAddress(),
    COVER_BOOK_ADDRESS: randomAddress(),
    COVER_POOL_ADDRESS: randomAddress(),
    WEATHER_INDEX_ADDRESS: randomAddress(),
    UNDERWRITER_PRIVATE_KEY: generatePrivateKey(),
    RELAYER_PRIVATE_KEY: generatePrivateKey(),
    REPORTER_PRIVATE_KEY: generatePrivateKey(),
    CRON_SECRET: "cron-secret-for-tests-0123456789",
    ...overrides,
  };
}
