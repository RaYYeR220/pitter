/**
 * The part of Multicall3 used to batch view calls into one request. `aggregate3` is declared `view` because it
 * is only ever called, never sent: that is how read clients expect it.
 */
export const multicall3Abi = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'view',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const
