#!/usr/bin/env node

/**
 * Check delegation status for an account on Kusama/Polkadot Asset Hub
 *
 * Usage:
 *   node check-delegation.js <account> [--network kusama|polkadot]
 */

const { ApiPromise, WsProvider } = require('@polkadot/api');

const NETWORKS = {
  kusama: {
    name: 'Kusama Asset Hub',
    endpoint: 'wss://sys.ibp.network:443/asset-hub-kusama',
    decimals: 12,
    symbol: 'KSM'
  },
  polkadot: {
    name: 'Polkadot Asset Hub',
    endpoint: 'wss://sys.ibp.network:443/asset-hub-polkadot',
    decimals: 10,
    symbol: 'DOT'
  }
};

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

async function main() {
  const args = process.argv.slice(2);
  const account = args.find(a => !a.startsWith('--'));
  const networkArg = args.find(a => a.startsWith('--network'));
  const network = networkArg ? args[args.indexOf(networkArg) + 1] : 'kusama';

  if (!account) {
    console.log('Usage: node check-delegation.js <account> [--network kusama|polkadot]');
    process.exit(1);
  }

  const config = NETWORKS[network];
  if (!config) {
    console.error(`Unknown network: ${network}. Use 'kusama' or 'polkadot'`);
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Delegation Status - ${config.name}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Account: ${account}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const provider = new WsProvider(config.endpoint);
  const api = await ApiPromise.create({ provider });

  console.log(`Connected to: ${await api.rpc.system.chain()}\n`);

  // Get all voting entries
  const entries = await api.query.convictionVoting.votingFor.entries(account);

  let delegationCount = 0;
  let voteCount = 0;
  let totalDelegated = BigInt(0);
  const delegations = [];
  const votes = [];

  for (const [key, voting] of entries) {
    const trackId = key.args[1].toNumber();
    const trackName = TRACK_NAMES[trackId] || `Track ${trackId}`;

    if (voting.isDelegating) {
      const del = voting.asDelegating;
      const balance = BigInt(del.balance.toString());
      totalDelegated = balance > totalDelegated ? balance : totalDelegated; // Max (same balance used across tracks)
      delegationCount++;
      delegations.push({
        trackId,
        trackName,
        target: del.target.toString(),
        balance,
        conviction: del.conviction.toString()
      });
    } else if (voting.isCasting) {
      const casting = voting.asCasting;
      for (const [refIndex] of casting.votes) {
        voteCount++;
        votes.push({
          trackId,
          trackName,
          refIndex: refIndex.toNumber()
        });
      }
    }
  }

  // Display delegations per track
  if (delegations.length > 0) {
    console.log(`Delegations (${delegationCount} tracks):\n`);

    // Sort by track ID
    delegations.sort((a, b) => a.trackId - b.trackId);

    for (const del of delegations) {
      const balanceStr = (Number(del.balance) / 10 ** config.decimals).toFixed(4);
      console.log(`  Track ${del.trackId} (${del.trackName}):`);
      console.log(`    Delegate:   ${del.target}`);
      console.log(`    Balance:    ${balanceStr} ${config.symbol}`);
      console.log(`    Conviction: ${del.conviction}`);
      console.log('');
    }
  } else {
    console.log('No active delegations.\n');
  }

  // Display votes
  if (votes.length > 0) {
    console.log(`Direct Votes (${voteCount}):\n`);
    const byTrack = new Map();
    for (const vote of votes) {
      if (!byTrack.has(vote.trackId)) {
        byTrack.set(vote.trackId, []);
      }
      byTrack.get(vote.trackId).push(vote.refIndex);
    }
    for (const [trackId, refs] of byTrack) {
      console.log(`  Track ${trackId} (${TRACK_NAMES[trackId] || 'Unknown'}): Refs #${refs.join(', #')}`);
    }
    console.log('');
  } else {
    console.log('No direct votes.\n');
  }

  // Summary
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Tracks delegated: ${delegationCount}`);
  console.log(`  Direct votes: ${voteCount}`);
  if (totalDelegated > 0) {
    console.log(`  Delegation amount: ${(Number(totalDelegated) / 10 ** config.decimals).toFixed(4)} ${config.symbol}`);
  }

  await api.disconnect();
}

main().catch(console.error);
