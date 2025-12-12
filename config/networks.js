// networks.js
const raw = {
  "Base Sepolia": {
    chainId: 84532,
    rpcUrl: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org/rpc',
    contractAddress: process.env.BASE_SEPOLIA_DEPAYM_CONTRACT || '0x85dACA1fF458dc95750a42a65799C5045754F612',
    tokens: {
      USDC: { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 },
      EURC: { address: '0x808456652fdb597867f38412077A9182bf77359F', decimals: 6 }
    }
  },
  "Optimism Sepolia": {
    chainId: 11155420,
    rpcUrl: process.env.OPTIMISM_SEPOLIA_RPC || 'https://sepolia.optimism.io',
    contractAddress: process.env.OPTIMISM_SEPOLIA_DEPAYM_CONTRACT || '0x...',
    tokens: {
      USDC: { address: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', decimals: 6 },
      EURC: { address: '0xE3F5a90F9c2a8b6f9694B4e3e1f0d7c4D2A0E1f8', decimals: 6 }
    }
  },
  "Arbitrum Sepolia": {
    chainId: 421614,
    rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc',
    contractAddress: process.env.ARBITRUM_SEPOLIA_DEPAYM_CONTRACT || '0x...',
    tokens: {
      USDC: { address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', decimals: 6 },
      EURC: { address: '0xE3F5a90F9c2a8b6f9694B4e3e1f0d7c4D2A0E1f8', decimals: 6 }
    }
  }
};

// Build quick-lookup maps
const networks = { ...raw };

// helper to create common aliases for a display name
const aliasesFor = (displayName) => {
  const lower = displayName.toLowerCase();
  const underscored = lower.replace(/\s+/g, "_");        // base_sepolia
  const dashed = lower.replace(/\s+/g, "-");            // base-sepolia
  const compact = lower.replace(/[^a-z0-9]/g, "");       // basesepolia
  const short = displayName.split(/\s+/)[0].toLowerCase();// base
  return Array.from(new Set([displayName, lower, underscored, dashed, compact, short]));
};

const aliasToDisplay = {};
const chainIdToDisplay = {};
for (const displayName of Object.keys(networks)) {
  const cfg = networks[displayName];
  chainIdToDisplay[String(cfg.chainId)] = displayName;
  for (const a of aliasesFor(displayName)) aliasToDisplay[a] = displayName;
}

// Public helper: try to resolve many forms to canonical display name + config
function getNetworkConfig(identifier) {
  if (identifier === undefined || identifier === null) return null;
  const id = String(identifier).trim();
  if (!id) return null;

  // numeric chainId
  if (/^\d+$/.test(id)) {
    const d = chainIdToDisplay[id];
    if (d) return { displayName: d, config: networks[d] };
  }

  // exact match (case-sensitive)
  if (networks[id]) return { displayName: id, config: networks[id] };

  // case-insensitive match
  const ci = Object.keys(networks).find(k => k.toLowerCase() === id.toLowerCase());
  if (ci) return { displayName: ci, config: networks[ci] };

  // alias map (includes underscored forms like base_sepolia)
  const lower = id.toLowerCase();
  if (aliasToDisplay[lower]) return { displayName: aliasToDisplay[lower], config: networks[aliasToDisplay[lower]] };

  // tolerate dashed/underscored variants
  const alt = id.replace(/[-_]+/g, " ").replace(/[^a-z0-9\s]/gi, "").trim();
  const altMatch = Object.keys(networks).find(k => k.toLowerCase().replace(/[^a-z0-9\s]/g,"") === alt.toLowerCase());
  if (altMatch) return { displayName: altMatch, config: networks[altMatch] };

  return null;
}

module.exports = { networks, getNetworkConfig };
