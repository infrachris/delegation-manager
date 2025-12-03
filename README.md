# Polkadot OpenGov Delegation Tools

Batch delegate, undelegate, and manage OpenGov governance on Polkadot and Kusama Asset Hub using proxy accounts.

## Overview

These scripts allow you to efficiently manage your OpenGov delegation across all 16 governance tracks without having to manually interact with each track through a UI. They use a **proxy account** to sign transactions on behalf of your main account.

**Supported Networks:**
- Polkadot Asset Hub (`wss://sys.ibp.network:443/asset-hub-polkadot`)
- Kusama Asset Hub (`wss://sys.ibp.network:443/asset-hub-kusama`)

> **Note:** As of November 2025, governance has migrated from the relay chains to Asset Hub. These scripts use the new Asset Hub endpoints.

## Prerequisites

### 1. Proxy Account Setup

You need a proxy account with **Governance** proxy type configured for your main account. The proxy account signs transactions that execute governance actions on behalf of your main account.

To set up a proxy:
1. Go to Polkadot.js Apps → Accounts → your account → "..." menu → Add proxy
2. Select proxy type: **Governance**
3. Add the proxy account address

### 2. Proxy Keyfile

Create a text file containing your proxy account's mnemonic phrase (the 12 or 24 word seed phrase) on the first line:

```
word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12
```

**Security:** Keep this file secure and never commit it to version control. Add it to `.gitignore`.

### 3. Proxy Account Balance

The proxy account needs a small balance to pay transaction fees. A few DOT/KSM is sufficient for multiple operations.

## Installation

```bash
npm install
```

## Scripts

### check-delegation.js

Check the current delegation status of an account.

```bash
node check-delegation.js <account> [--network kusama|polkadot]
```

**Examples:**
```bash
# Check Kusama delegations (default)
node check-delegation.js HqRcf...

# Check Polkadot delegations
node check-delegation.js 15D2J... --network polkadot
```

**Output:**
- Shows delegations for each track (delegate address, balance, conviction)
- Shows any direct votes
- Displays summary with total tracks delegated

---

### delegate.js

Delegate your voting power across all governance tracks.

```bash
node delegate.js <account> <keyfile> <delegate_to> <balance> <conviction> [options]
```

**Arguments:**
| Argument | Description |
|----------|-------------|
| `account` | Your account address (the one delegating) |
| `keyfile` | Path to file containing proxy mnemonic |
| `delegate_to` | Address to delegate your votes to |
| `balance` | Amount to delegate (e.g., 675 for KSM, 1000 for DOT) |
| `conviction` | Lock multiplier: `None`, `Locked1x` through `Locked6x` |

**Options:**
| Option | Description |
|--------|-------------|
| `--network N` | Network: `kusama` (default) or `polkadot` |
| `--dry-run` | Show what would be done without submitting |

**Examples:**
```bash
# Kusama - delegate 650 KSM with 5x conviction (dry run first)
node delegate.js <account> ./ksm-proxy.txt JKupaoCtkRzMjCDQJbVMbG1jmEr8ebtoRG7cmxWkc8vM2uZ 650 Locked5x --network kusama --dry-run

# Polkadot - delegate 8000 DOT with 5x conviction
node delegate.js <account> ./dot-proxy.txt 16fbkDCMrAo1uyC52NyA8Y2dETnYVpCofSoj3QEE2WUNnkLk 8000 Locked5x --network polkadot
```
(These examples delegate votes to INFRASTRUCTURE CORPORATION delegatee -- Thank you :)

---

### governance-cleanup.js

Remove all delegations and votes, and unlock expired conviction locks.

```bash
node governance-cleanup.js --network <network> --account <address> --keyfile <path> [options]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--network`, `-n` | Network: `kusama` or `polkadot` (required) |
| `--account`, `-a` | Your account address (required) |
| `--keyfile`, `-k` | Path to proxy mnemonic file |
| `--mnemonic`, `-m` | Prompt for mnemonic interactively |
| `--dry-run`, `-d` | Show what would be done without submitting |
| `--unlock-only`, `-u` | Only unlock expired locks, don't undelegate |

**Examples:**
```bash
# Dry run to see what would be removed
node governance-cleanup.js --network polkadot --account 15D2J... --keyfile ./dot-proxy.txt --dry-run

# Remove all delegations and votes on Kusama
node governance-cleanup.js --network kusama --account HqRcf... --keyfile ./ksm-proxy.txt

# Only unlock expired conviction locks
node governance-cleanup.js --network polkadot --account 15D2J... --keyfile ./dot-proxy.txt --unlock-only
```

## Governance Tracks

All 16 OpenGov tracks are supported:

| ID | Track Name |
|----|------------|
| 0 | Root |
| 1 | Whitelisted Caller |
| 2 | Staking Admin |
| 10 | Treasurer |
| 11 | Lease Admin |
| 12 | Fellowship Admin |
| 13 | General Admin |
| 14 | Auction Admin |
| 15 | Referendum Canceller |
| 20 | Referendum Killer |
| 21 | Small Tipper |
| 30 | Big Tipper |
| 31 | Small Spender |
| 32 | Medium Spender |
| 33 | Big Spender |
| 34 | Wish For Change |

## Conviction Lock Periods

| Conviction | Vote Power | Kusama Lock | Polkadot Lock |
|------------|------------|-------------|---------------|
| None | 0.1x | 0 days | 0 days |
| Locked1x | 1x | 7 days | 28 days |
| Locked2x | 2x | 14 days | 56 days |
| Locked3x | 3x | 28 days | 112 days |
| Locked4x | 4x | 56 days | 224 days |
| Locked5x | 5x | 112 days | 448 days |
| Locked6x | 6x | 224 days | 896 days |

Lock periods apply after undelegating. While delegated, tokens remain locked but the lock period doesn't start counting down.

## Overlapping Locks

Your staked tokens can be used for governance delegation. Polkadot/Kusama uses "overlapping locks" - the same tokens can be both staked and used for voting. You only need to wait for the conviction lock period if you want to transfer tokens that aren't staked.

## Batch Size Limits

Due to block weight limits, transactions are batched:
- **4 tracks per batch** (with proxy wrapper overhead)

The scripts automatically handle batching and wait between batches to ensure transactions are finalized.

## Troubleshooting

### "Transaction would exhaust the block limits"
The batch size is too large. The scripts are configured to use 4 tracks per batch which should work. If you still see this error, the RPC endpoint may be overloaded - try again later.

### "Inability to pay some fees"
The proxy account doesn't have enough balance to pay transaction fees. Send some DOT/KSM to the proxy account address.

### "No delegations or votes found"
The account may have already undelegated but has conviction locks that need to expire before tokens can be unlocked. Use `--unlock-only` to attempt unlocking expired locks.

### Warnings about "Unsupported unsigned extrinsic version 5"
This is a cosmetic warning from the polkadot.js library when decoding v5 extrinsics. Transactions still succeed - you can ignore this warning.

## SUPPORT

Please consider nominating us with your stake or delegating your votes to us:
Polkadot: 
16fbkDCMrAo1uyC52NyA8Y2dETnYVpCofSoj3QEE2WUNnkLk
Kusama:
JKupaoCtkRzMjCDQJbVMbG1jmEr8ebtoRG7cmxWkc8vM2uZ
