#!/usr/bin/env node

/**
 * Delegate voting power on Kusama/Polkadot Asset Hub
 *
 * Usage:
 *   node delegate.js <account> <keyfile> <delegate_to> <balance> <conviction> [--network kusama|polkadot] [--dry-run]
 *
 * Example:
 *   node delegate.js JKupa... ./proxy.txt HqRcf... 675 Locked6x --network kusama --dry-run
 *   node delegate.js 1abc... ./proxy.txt 1xyz... 1000 Locked5x --network polkadot
 */

const { ApiPromise, WsProvider } = require('@polkadot/api');
const { Keyring } = require('@polkadot/keyring');
const { cryptoWaitReady } = require('@polkadot/util-crypto');
const fs = require('fs');
const readline = require('readline');

const NETWORKS = {
  kusama: {
    name: 'Kusama Asset Hub',
    endpoint: 'wss://sys.ibp.network:443/asset-hub-kusama',
    decimals: 12,
    symbol: 'KSM',
    ss58Format: 2,
    baseLockDays: 7, // Kusama base lock period
    maxTracksPerBatch: 4
  },
  polkadot: {
    name: 'Polkadot Asset Hub',
    endpoint: 'wss://sys.ibp.network:443/asset-hub-polkadot',
    decimals: 10,
    symbol: 'DOT',
    ss58Format: 0,
    baseLockDays: 28, // Polkadot base lock period
    maxTracksPerBatch: 4
  }
};

// All governance tracks (same for both networks)
const ALL_TRACKS = [0, 1, 2, 10, 11, 12, 13, 14, 15, 20, 21, 30, 31, 32, 33, 34];

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

// Conviction multipliers (lock periods: Kusama base=7 days, Polkadot base=28 days)
const CONVICTION_MULTIPLIERS = {
  'None': { multiplier: 0.1, lockMultiplier: 0 },
  'Locked1x': { multiplier: 1, lockMultiplier: 1 },
  'Locked2x': { multiplier: 2, lockMultiplier: 2 },
  'Locked3x': { multiplier: 3, lockMultiplier: 4 },
  'Locked4x': { multiplier: 4, lockMultiplier: 8 },
  'Locked5x': { multiplier: 5, lockMultiplier: 16 },
  'Locked6x': { multiplier: 6, lockMultiplier: 32 }
};

function printUsage() {
  console.log(`
Usage:
  node delegate.js <account> <keyfile> <delegate_to> <balance> <conviction> [options]

Arguments:
  account       Your account address (the one delegating)
  keyfile       Path to proxy mnemonic file
  delegate_to   Address to delegate your votes to
  balance       Amount to delegate (e.g., 675 for KSM, 1000 for DOT)
  conviction    Lock multiplier: None, Locked1x, Locked2x, Locked3x, Locked4x, Locked5x, Locked6x

Options:
  --network N   Network: 'kusama' (default) or 'polkadot'
  --dry-run     Show what would be done without submitting
  --track N     Only delegate on specific track (can use multiple times)
  --all-tracks  Delegate on all tracks (default)

Examples:
  # Kusama - delegate 675 KSM with 5x conviction
  node delegate.js JKupa... ./proxy.txt HqRcf... 675 Locked5x --network kusama --dry-run

  # Polkadot - delegate 1000 DOT with 5x conviction
  node delegate.js 1abc... ./proxy.txt 1xyz... 1000 Locked5x --network polkadot --dry-run

Conviction lock periods:
                 Kusama    Polkadot
  None     = 0.1x,  0 days    0 days
  Locked1x = 1x,    7 days   28 days
  Locked2x = 2x,   14 days   56 days
  Locked3x = 3x,   28 days  112 days
  Locked4x = 4x,   56 days  224 days
  Locked5x = 5x,  112 days  448 days (~15 months)
  Locked6x = 6x,  224 days  896 days (~2.5 years)
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 5 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const account = args[0];
  const keyfile = args[1];
  const delegateTo = args[2];
  const balanceAmount = parseFloat(args[3]);
  const conviction = args[4];
  const dryRun = args.includes('--dry-run');

  // Parse network option
  const networkIdx = args.indexOf('--network');
  const networkName = networkIdx !== -1 && args[networkIdx + 1] ? args[networkIdx + 1].toLowerCase() : 'kusama';
  const network = NETWORKS[networkName];

  if (!network) {
    console.error(`Invalid network: ${networkName}. Use 'kusama' or 'polkadot'`);
    process.exit(1);
  }

  // Parse track options
  let tracks = ALL_TRACKS;
  const trackIndices = args.reduce((acc, arg, i) => {
    if (arg === '--track' && args[i + 1]) {
      acc.push(parseInt(args[i + 1]));
    }
    return acc;
  }, []);
  if (trackIndices.length > 0) {
    tracks = trackIndices;
  }

  // Validate conviction
  if (!CONVICTION_MULTIPLIERS[conviction]) {
    console.error(`Invalid conviction: ${conviction}`);
    console.error(`Valid options: ${Object.keys(CONVICTION_MULTIPLIERS).join(', ')}`);
    process.exit(1);
  }

  const convictionInfo = CONVICTION_MULTIPLIERS[conviction];
  const lockDays = convictionInfo.lockMultiplier * network.baseLockDays;
  const balancePlanck = BigInt(Math.floor(balanceAmount * (10 ** network.decimals)));

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Delegate Voting Power - ${network.name}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Your account:  ${account}`);
  console.log(`  Delegate to:   ${delegateTo}`);
  console.log(`  Balance:       ${balanceAmount} ${network.symbol} (${balancePlanck.toString()} planck)`);
  console.log(`  Conviction:    ${conviction} (${convictionInfo.multiplier}x power, ${lockDays} day lock)`);
  console.log(`  Voting power:  ${balanceAmount * convictionInfo.multiplier} ${network.symbol} equivalent`);
  console.log(`  Tracks:        ${tracks.length} (${tracks.join(', ')})`);
  if (dryRun) console.log('  Mode:          DRY RUN');
  console.log('═══════════════════════════════════════════════════════════\n');

  await cryptoWaitReady();

  const provider = new WsProvider(network.endpoint);
  const api = await ApiPromise.create({ provider });

  console.log(`Connected to: ${await api.rpc.system.chain()}\n`);

  // Check account balances
  console.log('Checking account state...\n');

  const accountInfo = await api.query.system.account(account);
  const free = BigInt(accountInfo.data.free.toString());
  const reserved = BigInt(accountInfo.data.reserved.toString());
  const frozen = BigInt(accountInfo.data.frozen?.toString() || '0');

  const divisor = 10 ** network.decimals;

  console.log('Balance:');
  console.log(`  Free:     ${(Number(free) / divisor).toFixed(4)} ${network.symbol}`);
  console.log(`  Reserved: ${(Number(reserved) / divisor).toFixed(4)} ${network.symbol}`);
  console.log(`  Frozen:   ${(Number(frozen) / divisor).toFixed(4)} ${network.symbol}`);
  console.log('');

  // Check staking
  if (api.query.staking?.ledger) {
    const ledger = await api.query.staking.ledger(account);
    if (!ledger.isEmpty) {
      const l = ledger.unwrap();
      console.log('Staking:');
      console.log(`  Bonded:   ${(Number(BigInt(l.total.toString())) / divisor).toFixed(4)} ${network.symbol}`);
      console.log(`  Active:   ${(Number(BigInt(l.active.toString())) / divisor).toFixed(4)} ${network.symbol}`);
      console.log('');
    }
  }

  // Check current delegations
  console.log('Current delegations:');
  let existingDelegations = 0;
  for (const trackId of tracks) {
    const voting = await api.query.convictionVoting.votingFor(account, trackId);
    if (voting.isDelegating) {
      existingDelegations++;
      const del = voting.asDelegating;
      console.log(`  Track ${trackId}: Delegating ${(Number(BigInt(del.balance.toString())) / divisor).toFixed(4)} ${network.symbol} to ${del.target.toString().slice(0, 16)}...`);
    }
  }
  if (existingDelegations === 0) {
    console.log('  (none)');
  }
  console.log('');

  // Load proxy
  if (!fs.existsSync(keyfile)) {
    console.error(`Keyfile not found: ${keyfile}`);
    process.exit(1);
  }

  const mnemonic = fs.readFileSync(keyfile, 'utf8').split('\n')[0].trim();
  const keyring = new Keyring({ type: 'sr25519', ss58Format: network.ss58Format });
  const proxyKeyPair = keyring.addFromMnemonic(mnemonic);

  console.log(`Proxy account: ${proxyKeyPair.address}\n`);

  // Build delegate calls for each track
  const calls = tracks.map(trackId => ({
    call: api.tx.convictionVoting.delegate(trackId, delegateTo, conviction, balancePlanck),
    trackId,
    description: `delegate(${trackId}, ${delegateTo.slice(0, 8)}..., ${conviction}, ${balanceAmount} ${network.symbol})`
  }));

  console.log(`Will submit ${calls.length} delegate calls:`);
  for (const c of calls) {
    const name = TRACK_NAMES[c.trackId] || `Track ${c.trackId}`;
    console.log(`  • Track ${c.trackId} (${name})`);
  }
  console.log('');

  if (dryRun) {
    console.log('[DRY RUN] Would submit batch of delegate calls\n');

    // Show the encoded call
    const batchCall = api.tx.utility.batchAll(calls.map(c => c.call));
    const proxyCall = api.tx.proxy.proxy(account, null, batchCall);
    console.log(`Encoded call (first 200 chars): ${proxyCall.method.toHex().slice(0, 200)}...`);
    console.log(`\nTo execute for real, remove --dry-run flag`);

    await api.disconnect();
    return;
  }

  // Confirmation
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('WARNING: This will delegate your voting power!');
  console.log(`Lock period: ${lockDays} days after undelegating\n`);

  const answer = await new Promise((resolve) => {
    rl.question('Type "yes" to proceed: ', resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== 'yes') {
    console.log('Aborted.');
    await api.disconnect();
    return;
  }

  // Submit - use batchAll so it's atomic (all succeed or all fail)
  // Use small batches to stay under block weight limits with proxy wrapper
  const MAX_PER_BATCH = network.maxTracksPerBatch;
  const batches = [];
  for (let i = 0; i < calls.length; i += MAX_PER_BATCH) {
    batches.push(calls.slice(i, i + MAX_PER_BATCH));
  }

  console.log(`\nSubmitting ${batches.length} batch(es)...\n`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`--- Batch ${i + 1}/${batches.length} (${batch.length} tracks) ---`);

    const batchCall = api.tx.utility.batchAll(batch.map(c => c.call));
    const proxyCall = api.tx.proxy.proxy(account, null, batchCall);

    try {
      const TIMEOUT_MS = 120000; // 2 minute timeout

      await new Promise((resolve, reject) => {
        let unsub;

        // Set timeout
        const timeout = setTimeout(() => {
          if (unsub) unsub();
          reject(new Error('Transaction timeout - no response after 2 minutes'));
        }, TIMEOUT_MS);

        proxyCall.signAndSend(proxyKeyPair, { nonce: -1 }, ({ status, events, dispatchError }) => {
          // Handle immediate errors
          if (dispatchError) {
            clearTimeout(timeout);
            if (dispatchError.isModule) {
              const decoded = api.registry.findMetaError(dispatchError.asModule);
              reject(new Error(`${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`));
            } else {
              reject(new Error(dispatchError.toString()));
            }
            return;
          }

          // Handle dropped/invalid status
          if (status.isDropped) {
            clearTimeout(timeout);
            reject(new Error('Transaction was dropped'));
            return;
          }
          if (status.isInvalid) {
            clearTimeout(timeout);
            reject(new Error('Transaction is invalid'));
            return;
          }
          if (status.isUsurped) {
            clearTimeout(timeout);
            reject(new Error('Transaction was usurped'));
            return;
          }

          if (status.isInBlock) {
            console.log(`  In block: ${status.asInBlock.toHex()}`);

            // Check for errors in events
            for (const { event } of events) {
              if (event.section === 'system' && event.method === 'ExtrinsicFailed') {
                const error = event.data[0];
                if (error.isModule) {
                  const decoded = api.registry.findMetaError(error.asModule);
                  console.log(`  ERROR: ${decoded.section}.${decoded.name}: ${decoded.docs.join(' ')}`);
                } else {
                  console.log(`  ERROR: ${error.toString()}`);
                }
              }
              if (event.section === 'convictionVoting' && event.method === 'Delegated') {
                console.log(`  SUCCESS: ${event.section}.${event.method}`);
              }
            }
          }

          if (status.isFinalized) {
            clearTimeout(timeout);
            console.log(`  Finalized: ${status.asFinalized.toHex()}`);
            resolve(true);
          }
        }).then(unsubFn => { unsub = unsubFn; }).catch(err => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    } catch (error) {
      console.error(`  Transaction error: ${error.message}`);
      // Continue with next batch
    }

    // Delay between batches
    if (i < batches.length - 1) {
      console.log('  Waiting 6 seconds before next batch...\n');
      await new Promise(r => setTimeout(r, 6000));
    }
  }

  // Verify final state
  console.log('\n\nVerifying final state...\n');

  console.log('New delegations:');
  for (const trackId of tracks) {
    const voting = await api.query.convictionVoting.votingFor(account, trackId);
    if (voting.isDelegating) {
      const del = voting.asDelegating;
      console.log(`  Track ${trackId}: ✓ Delegating ${(Number(BigInt(del.balance.toString())) / (10 ** network.decimals)).toFixed(4)} ${network.symbol} @ ${del.conviction.toString()}`);
    } else {
      console.log(`  Track ${trackId}: ✗ Not delegating`);
    }
  }

  await api.disconnect();
  console.log('\nDone!');
}

main().catch(console.error);
