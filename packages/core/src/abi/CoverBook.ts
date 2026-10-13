export const coverBookAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "token_",
        "type": "address",
        "internalType": "contract IERC20"
      },
      {
        "name": "pool_",
        "type": "address",
        "internalType": "contract ICoverPool"
      },
      {
        "name": "index_",
        "type": "address",
        "internalType": "contract IWeatherIndex"
      },
      {
        "name": "underwriter_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "treasury_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "minLead_",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "maxPolicyPayout_",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "initialOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "DOMAIN_SEPARATOR",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_FEE_BPS",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_EXPIRY_GRACE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "QUOTE_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "activeCells",
    "inputs": [],
    "outputs": [
      {
        "name": "keys",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "buy",
    "inputs": [
      {
        "name": "q",
        "type": "tuple",
        "internalType": "struct Quote",
        "components": [
          {
            "name": "holder",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "key",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "start",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "end",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "ratePerSecond",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "premium",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "expiry",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "salt",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "quoteSig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "buyWithAuthorization",
    "inputs": [
      {
        "name": "q",
        "type": "tuple",
        "internalType": "struct Quote",
        "components": [
          {
            "name": "holder",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "key",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "start",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "end",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "ratePerSecond",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "premium",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "expiry",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "salt",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      },
      {
        "name": "quoteSig",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "validAfter",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "validBefore",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "v",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "r",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "s",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "claimable",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "eip712Domain",
    "inputs": [],
    "outputs": [
      {
        "name": "fields",
        "type": "bytes1",
        "internalType": "bytes1"
      },
      {
        "name": "name",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "version",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "chainId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "verifyingContract",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "salt",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "extensions",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "expire",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "expiryGrace",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "feeBps",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "hashQuote",
    "inputs": [
      {
        "name": "q",
        "type": "tuple",
        "internalType": "struct Quote",
        "components": [
          {
            "name": "holder",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "key",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "start",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "end",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "ratePerSecond",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "premium",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "expiry",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "salt",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "index",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IWeatherIndex"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxActiveCells",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxDuration",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxHorizon",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxOracleAge",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxPolicyPayout",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "minDuration",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "minLead",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "minPremium",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint128",
        "internalType": "uint128"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "openPolicies",
    "inputs": [
      {
        "name": "key",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingOwner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "policies",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "holder",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "key",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "start",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "end",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "ratePerSecond",
        "type": "uint128",
        "internalType": "uint128"
      },
      {
        "name": "premium",
        "type": "uint128",
        "internalType": "uint128"
      },
      {
        "name": "maxPayout",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "paid",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "settledUntil",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "closed",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "policyCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pool",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract ICoverPool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "quoteUsed",
    "inputs": [
      {
        "name": "digest",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setDurationBounds",
    "inputs": [
      {
        "name": "minDuration_",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "maxDuration_",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setExpiryGrace",
    "inputs": [
      {
        "name": "expiryGrace_",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setFeeBps",
    "inputs": [
      {
        "name": "feeBps_",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setMaxActiveCells",
    "inputs": [
      {
        "name": "maxActiveCells_",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setMaxHorizon",
    "inputs": [
      {
        "name": "maxHorizon_",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setMaxOracleAge",
    "inputs": [
      {
        "name": "maxOracleAge_",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setMaxPolicyPayout",
    "inputs": [
      {
        "name": "maxPolicyPayout_",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setMinLead",
    "inputs": [
      {
        "name": "minLead_",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setMinPremium",
    "inputs": [
      {
        "name": "minPremium_",
        "type": "uint128",
        "internalType": "uint128"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setTreasury",
    "inputs": [
      {
        "name": "treasury_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setUnderwriter",
    "inputs": [
      {
        "name": "underwriter_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "settle",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "paid",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "settleMany",
    "inputs": [
      {
        "name": "ids",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "token",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "transferOwnership",
    "inputs": [
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "treasury",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "underwriter",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "DurationBoundsSet",
    "inputs": [
      {
        "name": "minDuration",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "maxDuration",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "EIP712DomainChanged",
    "inputs": [],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ExpiryGraceSet",
    "inputs": [
      {
        "name": "expiryGrace",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FeeSet",
    "inputs": [
      {
        "name": "feeBps",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MaxActiveCellsSet",
    "inputs": [
      {
        "name": "maxActiveCells",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MaxHorizonSet",
    "inputs": [
      {
        "name": "maxHorizon",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MaxOracleAgeSet",
    "inputs": [
      {
        "name": "maxOracleAge",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MaxPolicyPayoutSet",
    "inputs": [
      {
        "name": "maxPolicyPayout",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MinLeadSet",
    "inputs": [
      {
        "name": "minLead",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MinPremiumSet",
    "inputs": [
      {
        "name": "minPremium",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferStarted",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferred",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PolicyBought",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "holder",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "key",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "start",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "end",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "ratePerSecond",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      },
      {
        "name": "premium",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      },
      {
        "name": "maxPayout",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PolicySettled",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "holder",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "paid",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "settledUntil",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "closed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TreasurySet",
    "inputs": [
      {
        "name": "treasury",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "UnderwriterSet",
    "inputs": [
      {
        "name": "underwriter",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "BadQuoteSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ConfigInvalid",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ExpiryNotReached",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidShortString",
    "inputs": []
  },
  {
    "type": "error",
    "name": "LeadTooShort",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OracleStale",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OwnableInvalidOwner",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "OwnableUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "PolicyTooLarge",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PolicyUnknown",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PremiumNotReceived",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PremiumTooSmall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "QuoteExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "QuoteUsed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeCastOverflowedUintDowncast",
    "inputs": [
      {
        "name": "bits",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "StringTooLong",
    "inputs": [
      {
        "name": "str",
        "type": "string",
        "internalType": "string"
      }
    ]
  },
  {
    "type": "error",
    "name": "TooManyCells",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WindowInvalid",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WindowTooFar",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const
