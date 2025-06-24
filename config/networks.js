module.exports = {
  networks: {
    "Base Sepolia": {
      chainId: 84532,
      rpcUrl: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org/rpc',
      contractAddress: process.env.BASE_SEPOLIA_DEPAYM_CONTRACT || '0x85dACA1fF458dc95750a42a65799C5045754F612',
      tokens: {
        USDC: {
          address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          decimals: 6
        },
        EURC: {
          address: '0x808456652fdb597867f38412077A9182bf77359F',
          decimals: 6
        }
      }
    },
    "Optimism Sepolia": {
      chainId: 11155420,
      rpcUrl: process.env.OPTIMISM_SEPOLIA_RPC || 'https://sepolia.optimism.io',
      contractAddress: process.env.OPTIMISM_SEPOLIA_DEPAYM_CONTRACT || '0x...',
      tokens: {
        USDC: {
          address: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
          decimals: 6
        },
        EURC: {
          address: '0xE3F5a90F9c2a8b6f9694B4e3e1f0d7c4D2A0E1f8',
          decimals: 6
        }
      }
    },
    "Arbitrum Sepolia": {
      chainId: 421614,
      rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc',
      contractAddress: process.env.ARBITRUM_SEPOLIA_DEPAYM_CONTRACT || '0x...',
      tokens: {
        USDC: {
          address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
          decimals: 6
        },
        EURC: {
          address: '0xE3F5a90F9c2a8b6f9694B4e3e1f0d7c4D2A0E1f8',
          decimals: 6
        }
      }
    }
  }
};