#!/usr/bin/env node

/**
 * Polkadot/Kusama OpenGov Batch Undelegate & Remove Votes Script
 *
 * Removes all delegations and votes across all governance tracks,
 * and optionally unlocks expired conviction locks.
 * Uses a proxy account to sign transactions.
 *
 * Usage:
 *   node governance-cleanup.js --network polkadot --account <SS58_ADDRESS> --keyfile <PATH>
 *   node governance-cleanup.js --network kusama --account <SS58_ADDRESS> --keyfile <PATH>
 *   node governance-cleanup.js --network polkadot --account <SS58_ADDRESS> --mnemonic
 *
 * The keyfile should contain the proxy account's mnemonic (first line).
 */

const { ApiPromise, WsProvider } = require('@polkadot/api');
const { Keyring } = require('@polkadot/keyring');
const { cryptoWaitReady } = require('@polkadot/util-crypto');
const fs = require('fs');
const readline = require('readline');

// Network configurations - Asset Hub endpoints (post-migration Nov 2025)
const NETWORKS = {
  polkadot: {
    name: 'Polkadot Asset Hub',
    endpoint: 'wss://sys.ibp.network:443/asset-hub-polkadot',
    ss58Format: 0,
    maxTracksPerBatch: 4, // Reduced - exceeds block limits with proxy wrapper
    decimals: 10,
    symbol: 'DOT'
  },
  kusama: {
    name: 'Kusama Asset Hub',
    endpoint: 'wss://sys.ibp.network:443/asset-hub-kusama',
    ss58Format: 2,
    maxTracksPerBatch: 4, // Reduced - 9 exceeds block limits with proxy wrapper
    decimals: 12,
    symbol: 'KSM'
  }
};

// Track names for display (Kusama has more tracks than Polkadot)
const TRACK_NAMES = {
  0: 'Root',
  1: 'Whitelisted Caller',
  2: 'Staking Admin',
  10: 'Treasurer',
  11: 'Lease Admin',
  12: 'Fellowship Admin',
  13: 'General Admin',
  14: 'Auction Admin',
  15: 'Referendum Canceller',
  20: 'Referendum Killer',
  21: 'Small Tipper',
  30: 'Big Tipper',
  31: 'Small Spender',
  32: 'Medium Spender',
  33: 'Big Spender',
  34: 'Wish For Change'
};

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    network: null,
    account: null,
    keyfile: null,
    useMnemonic: false,
    dryRun: false,
    unlockOnly: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--network':
      case '-n':
        config.network = args[++i]?.toLowerCase();
        break;
      case '--account':
      case '-a':
        config.account = args[++i];
        break;
      case '--keyfile':
      case '-k':
        config.keyfile = args[++i];
        break;
      case '--mnemonic':
      case '-m':
        config.useMnemonic = true;
        break;
      case '--dry-run':
      case '-d':
        config.dryRun = true;
        break;
      case '--unlock-only':
      case '-u':
        config.unlockOnly = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return config;
}

function printHelp() {
  console.log(`
Polkadot/Kusama OpenGov Batch Undelegate & Remove Votes

Usage:
  node governance-cleanup.js [options]

Options:
  -n, --network <name>    Network: 'polkadot' or 'kusama' (required)
  -a, --account <addr>    The account to clean up delegations/votes for (required)
  -k, --keyfile <path>    Path to file containing proxy mnemonic
  -m, --mnemonic          Prompt for mnemonic interactively
  -d, --dry-run           Show what would be done without submitting
  -u, --unlock-only       Only unlock expired locks (skip undelegate/removeVote)
  -h, --help              Show this help

Examples:
  # Full cleanup using keyfile
  node governance-cleanup.js -n polkadot -a 1abc... -k ./proxy-mnemonic.txt

  # Dry run to see what would happen
  node governance-cleanup.js -n kusama -a Habcd... -k ./key.txt --dry-run

  # Only unlock expired conviction locks
  node governance-cleanup.js -n kusama -a Habcd... -k ./key.txt --unlock-only

Notes:
  - The proxy account must have 'Governance' or 'Any' proxy type for the target account
  - Kusama has a limit of 9 tracks per batch call
  - The script will automatically split into multiple transactions if needed
  - Locks can only be unlocked after the conviction period expires
`);
}

async function promptMnemonic() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    process.stdout.write('Enter proxy mnemonic: ');

    let mnemonic = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = (char) => {
      if (char === '\n' || char === '\r') {
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', onData);
        console.log('');
        rl.close();
        resolve(mnemonic.trim());
      } else if (char === '\u0003') {
        process.exit();
      } else if (char === '\u007F') {
        mnemonic = mnemonic.slice(0, -1);
      } else {
        mnemonic += char;
      }
    };

    process.stdin.on('data', onData);
  });
}

async function getMnemonic(config) {
  if (config.keyfile) {
    if (!fs.existsSync(config.keyfile)) {
      throw new Error(`Keyfile not found: ${config.keyfile}`);
    }
    const content = fs.readFileSync(config.keyfile, 'utf8');
    return content.split('\n')[0].trim();
  } else if (config.useMnemonic) {
    return await promptMnemonic();
  } else {
    throw new Error('Must specify --keyfile or --mnemonic');
  }
}

async function getVotingInfo(api, account) {
  console.log('\nQuerying voting state across all tracks...\n');

  const delegations = [];
  const votes = [];
  const priorLocks = [];

  // Query all tracks for this account
  const votingEntries = await api.query.convictionVoting.votingFor.entries(account);

  const currentBlock = (await api.rpc.chain.getHeader()).number.toNumber();

  for (const [key, voting] of votingEntries) {
    const trackId = key.args[1].toNumber();
    const trackName = TRACK_NAMES[trackId] || `Track ${trackId}`;

    if (voting.isDelegating) {
      const delegating = voting.asDelegating;
      delegations.push({
        trackId,
        trackName,
        target: delegating.target.toString(),
        conviction: delegating.conviction.toString(),
        balance: delegating.balance.toString()
      });
    } else if (voting.isCasting) {
      const casting = voting.asCasting;

      // Check for active votes
      for (const [refIndex, vote] of casting.votes) {
        votes.push({
          trackId,
          trackName,
          refIndex: refIndex.toNumber()
        });
      }

      // Check for prior locks (expired delegations/votes that can be unlocked)
      const prior = casting.prior;
      if (prior && prior.length >= 2) {
        const unlockBlock = prior[0].toNumber ? prior[0].toNumber() : parseInt(prior[0].toString().replace(/,/g, ''));
        const amount = prior[1].toString();

        if (unlockBlock > 0 && amount !== '0') {
          priorLocks.push({
            trackId,
            trackName,
            unlockBlock,
            amount,
            isExpired: currentBlock >= unlockBlock,
            blocksRemaining: Math.max(0, unlockBlock - currentBlock)
          });
        }
      }
    }
  }

  // Also get class locks
  const classLocks = await api.query.convictionVoting.classLocksFor(account);
  const lockedTracks = [];
  if (classLocks && classLocks.length > 0) {
    for (const [trackId, amount] of classLocks) {
      lockedTracks.push({
        trackId: trackId.toNumber(),
        amount: amount.toString()
      });
    }
  }

  return { delegations, votes, priorLocks, lockedTracks, currentBlock };
}

function buildCleanupCalls(api, delegations, votes, priorLocks, account, unlockOnly) {
  const calls = [];

  if (!unlockOnly) {
    // Group by track
    const trackData = new Map();

    for (const del of delegations) {
      if (!trackData.has(del.trackId)) {
        trackData.set(del.trackId, { delegated: false, votes: [] });
      }
      trackData.get(del.trackId).delegated = true;
    }

    for (const vote of votes) {
      if (!trackData.has(vote.trackId)) {
        trackData.set(vote.trackId, { delegated: false, votes: [] });
      }
      trackData.get(vote.trackId).votes.push(vote.refIndex);
    }

    // First: all undelegates
    for (const [trackId, data] of trackData) {
      if (data.delegated) {
        calls.push({
          call: api.tx.convictionVoting.undelegate(trackId),
          description: `Undelegate from track ${trackId} (${TRACK_NAMES[trackId] || 'Unknown'})`
        });
      }
    }

    // Second: all vote removals
    for (const [trackId, data] of trackData) {
      for (const refIndex of data.votes) {
        calls.push({
          call: api.tx.convictionVoting.removeVote(trackId, refIndex),
          description: `Remove vote on referendum #${refIndex} (track ${trackId})`
        });
      }
    }
  }

  // Third: unlock expired locks
  const tracksToUnlock = new Set();
  for (const lock of priorLocks) {
    if (lock.isExpired) {
      tracksToUnlock.add(lock.trackId);
    }
  }

  for (const trackId of tracksToUnlock) {
    calls.push({
      call: api.tx.convictionVoting.unlock(trackId, account),
      description: `Unlock expired lock on track ${trackId} (${TRACK_NAMES[trackId] || 'Unknown'})`
    });
  }

  return calls;
}

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function submitBatchViaProxy(api, proxyKeyPair, targetAccount, calls, networkConfig, dryRun) {
  const maxCallsPerBatch = networkConfig.maxTracksPerBatch; // Proxy wrapper adds overhead, keep batches small
  const batches = chunkArray(calls, maxCallsPerBatch);

  console.log(`\nWill submit ${batches.length} batch transaction(s)...\n`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`\n--- Batch ${i + 1}/${batches.length} (${batch.length} calls) ---`);

    for (const item of batch) {
      console.log(`  • ${item.description}`);
    }

    if (dryRun) {
      console.log('\n  [DRY RUN] Would submit this batch');
      continue;
    }

    const batchCall = api.tx.utility.batchAll(batch.map(item => item.call));
    const proxyCall = api.tx.proxy.proxy(targetAccount, null, batchCall);

    console.log('\n  Submitting transaction...');

    try {
      await new Promise((resolve, reject) => {
        proxyCall.signAndSend(proxyKeyPair, { nonce: -1 }, ({ status, dispatchError }) => {
          if (status.isInBlock) {
            console.log(`  ✓ Included in block: ${status.asInBlock.toHex()}`);
          }

          if (status.isFinalized) {
            if (dispatchError) {
              if (dispatchError.isModule) {
                const decoded = api.registry.findMetaError(dispatchError.asModule);
                reject(new Error(`${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`));
              } else {
                reject(new Error(dispatchError.toString()));
              }
            } else {
              console.log(`  ✓ Finalized in block: ${status.asFinalized.toHex()}`);
              resolve(true);
            }
          }
        });
      });
    } catch (error) {
      console.error(`  ✗ Transaction failed: ${error.message}`);
      throw error;
    }

    if (i < batches.length - 1) {
      console.log('\n  Waiting 6 seconds before next batch...');
      await new Promise(r => setTimeout(r, 6000));
    }
  }
}

function formatBlocks(blocks) {
  // Approximate: 6 seconds per block
  const seconds = blocks * 6;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);

  if (days > 0) {
    return `~${days}d ${hours}h`;
  } else if (hours > 0) {
    return `~${hours}h`;
  } else {
    return `~${Math.floor(seconds / 60)}m`;
  }
}

async function main() {
  const config = parseArgs();

  if (!config.network || !NETWORKS[config.network]) {
    console.error('Error: Must specify --network (polkadot or kusama)');
    process.exit(1);
  }

  if (!config.account) {
    console.error('Error: Must specify --account (the account to clean up)');
    process.exit(1);
  }

  if (!config.keyfile && !config.useMnemonic) {
    console.error('Error: Must specify --keyfile or --mnemonic for proxy signing');
    process.exit(1);
  }

  const networkConfig = NETWORKS[config.network];

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  OpenGov Cleanup Script - ${networkConfig.name}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Target account: ${config.account}`);
  console.log(`  Endpoint: ${networkConfig.endpoint}`);
  if (config.dryRun) {
    console.log('  Mode: DRY RUN (no transactions will be submitted)');
  }
  if (config.unlockOnly) {
    console.log('  Mode: UNLOCK ONLY (skip undelegate/removeVote)');
  }
  console.log('═══════════════════════════════════════════════════════════');

  await cryptoWaitReady();

  console.log('\nLoading proxy account...');
  const mnemonic = await getMnemonic(config);

  const keyring = new Keyring({ type: 'sr25519', ss58Format: networkConfig.ss58Format });
  const proxyKeyPair = keyring.addFromMnemonic(mnemonic);

  console.log(`  Proxy account: ${proxyKeyPair.address}`);

  console.log(`\nConnecting to ${networkConfig.name}...`);
  const provider = new WsProvider(networkConfig.endpoint);
  const api = await ApiPromise.create({ provider });

  console.log(`  Connected to chain: ${(await api.rpc.system.chain()).toString()}`);

  const { delegations, votes, priorLocks, lockedTracks, currentBlock } = await getVotingInfo(api, config.account);

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Current State (block #${currentBlock})`);
  console.log('═══════════════════════════════════════════════════════════');

  // Show delegations
  if (delegations.length > 0) {
    console.log(`\n  Active Delegations (${delegations.length}):`);
    for (const del of delegations) {
      const balance = BigInt(del.balance) / BigInt(10 ** networkConfig.decimals);
      console.log(`    • Track ${del.trackId} (${del.trackName}): ${balance} ${networkConfig.symbol} @ ${del.conviction}`);
      console.log(`      → Delegate: ${del.target.slice(0, 16)}...`);
    }
  } else {
    console.log('\n  No active delegations.');
  }

  // Show votes
  if (votes.length > 0) {
    console.log(`\n  Active Votes (${votes.length}):`);
    const votesByTrack = new Map();
    for (const vote of votes) {
      if (!votesByTrack.has(vote.trackId)) {
        votesByTrack.set(vote.trackId, []);
      }
      votesByTrack.get(vote.trackId).push(vote.refIndex);
    }
    for (const [trackId, refs] of votesByTrack) {
      console.log(`    • Track ${trackId} (${TRACK_NAMES[trackId] || 'Unknown'}): Refs #${refs.join(', #')}`);
    }
  } else {
    console.log('  No active votes.');
  }

  // Show prior locks
  if (priorLocks.length > 0) {
    const expiredLocks = priorLocks.filter(l => l.isExpired);
    const pendingLocks = priorLocks.filter(l => !l.isExpired);

    if (expiredLocks.length > 0) {
      console.log(`\n  Expired Locks (ready to unlock) (${expiredLocks.length}):`);
      for (const lock of expiredLocks) {
        const amount = BigInt(lock.amount) / BigInt(10 ** networkConfig.decimals);
        console.log(`    • Track ${lock.trackId} (${lock.trackName}): ${amount} ${networkConfig.symbol} ✓ READY`);
      }
    }

    if (pendingLocks.length > 0) {
      console.log(`\n  Pending Locks (still locked) (${pendingLocks.length}):`);
      for (const lock of pendingLocks) {
        const amount = BigInt(lock.amount) / BigInt(10 ** networkConfig.decimals);
        console.log(`    • Track ${lock.trackId} (${lock.trackName}): ${amount} ${networkConfig.symbol}`);
        console.log(`      → Unlocks at block #${lock.unlockBlock} (${formatBlocks(lock.blocksRemaining)} remaining)`);
      }
    }
  }

  // Show class locks summary
  if (lockedTracks.length > 0) {
    console.log(`\n  Class Locks Summary (${lockedTracks.length} tracks):`);
    const trackIds = lockedTracks.map(l => l.trackId).join(', ');
    console.log(`    Tracks: ${trackIds}`);
  }

  // Build cleanup calls
  const calls = buildCleanupCalls(api, delegations, votes, priorLocks, config.account, config.unlockOnly);

  if (calls.length === 0) {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  Nothing to do!');
    console.log('═══════════════════════════════════════════════════════════');

    if (priorLocks.some(l => !l.isExpired)) {
      console.log('\n  Some locks are still pending. Run again after they expire.');
    }

    await api.disconnect();
    return;
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  Will execute ${calls.length} call(s)`);
  console.log('═══════════════════════════════════════════════════════════');

  if (!config.dryRun) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await new Promise((resolve) => {
      rl.question('\nProceed? (yes/no): ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'yes' && answer.toLowerCase() !== 'y') {
      console.log('Aborted.');
      await api.disconnect();
      return;
    }
  }

  await submitBatchViaProxy(api, proxyKeyPair, config.account, calls, networkConfig, config.dryRun);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Complete!');
  console.log('═══════════════════════════════════════════════════════════');

  await api.disconnect();
}

main().catch((error) => {
  console.error('\nFatal error:', error.message);
  process.exit(1);
});
