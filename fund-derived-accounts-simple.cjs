const { zkVerifySession } = require("zkverifyjs");
const { ApiPromise, WsProvider } = require('@polkadot/api');
const { Keyring } = require('@polkadot/keyring');
const { cryptoWaitReady, mnemonicToMiniSecret, ed25519PairFromSeed } = require('@polkadot/util-crypto');
const dotenv = require('dotenv');

dotenv.config();

async function fundDerivedAccountsSimple() {
    try {
        console.log('💰 Funding derived accounts using Polkadot API...');
        
        // Wait for crypto to be ready
        await cryptoWaitReady();
        
        // Initialize zkVerify session to get derived accounts
        const session = await zkVerifySession.start().Volta().withAccount(process.env.SEED_PHRASE);
        const initialAccountInfo = await session.getAccountInfo();
        const baseAddress = initialAccountInfo[0].address;
        
        console.log('\n📍 Base Account:');
        console.log(`   Address: ${baseAddress}`);
        console.log(`   Balance: ${initialAccountInfo[0].freeBalance} smallest units`);
        
        // Derive the accounts
        const derivedAddresses = await session.addDerivedAccounts(baseAddress, 7);
        console.log(`✅ Found ${derivedAddresses.length} derived accounts to fund`);
        
        // Check current balances first
        console.log('\n💰 Checking current balances...');
        const allAccountInfo = await session.getAccountInfo();
        
        const accountsNeedingFunds = [];
        allAccountInfo.forEach((account, index) => {
            const balanceVOL = Number(BigInt(account.freeBalance) / BigInt('1000000000000000000'));
            console.log(`   Account ${index + 1} (${account.address.slice(0, 8)}...): ${balanceVOL} VOL`);
            
            if (index > 0 && balanceVOL < 200) { // Skip base account (index 0), only fund accounts with < 200 VOL
                accountsNeedingFunds.push({
                    address: account.address,
                    index: index + 1,
                    currentBalance: balanceVOL
                });
            }
        });
        
        if (accountsNeedingFunds.length === 0) {
            console.log('\n🎉 All derived accounts already have sufficient funds (≥200 VOL)!');
            console.log('💾 No transfers needed.');
            process.exit(0);
        }
        
        console.log(`\n📋 Found ${accountsNeedingFunds.length} accounts needing funds:`);
        accountsNeedingFunds.forEach(account => {
            console.log(`   Account ${account.index} (${account.address.slice(0, 8)}...): ${account.currentBalance} VOL (needs funding)`);
        });
        
        // Connect directly to zkVerify API
        const provider = new WsProvider('wss://testnet-rpc.zkverify.io');
        const api = await ApiPromise.create({ provider });
        
        // Create keyring and add account from seed phrase
        const keyring = new Keyring({ type: 'sr25519' });
        const sender = keyring.addFromMnemonic(process.env.SEED_PHRASE);
        
        console.log(`\n🔑 Sender account: ${sender.address}`);
        
        // Amount to transfer (1000 VOL = 1000 * 10^18 smallest units)
        const transferAmount = '1000000000000000000000';
        
        console.log('\n💸 Starting transfers...');
        console.log('=' .repeat(80));
        
        // Process transfers sequentially to avoid nonce issues
        let successfulTransfers = 0;
        let failedTransfers = 0;
        
        for (let i = 0; i < accountsNeedingFunds.length; i++) {
            const account = accountsNeedingFunds[i];
            const targetAddress = account.address;
            
            try {
                console.log(`\n🔄 Transfer ${i + 1}/${accountsNeedingFunds.length}: Sending 1000 VOL to Account ${account.index}`);
                console.log(`   Target: ${targetAddress.slice(0, 8)}...${targetAddress.slice(-8)}`);
                console.log(`   Current balance: ${account.currentBalance} VOL`);
                
                // Create transfer transaction (zkVerify uses transferAllowDeath)
                const transfer = api.tx.balances.transferAllowDeath(targetAddress, transferAmount);
                
                // Sign and send
                const hash = await transfer.signAndSend(sender);
                console.log(`   Transaction hash: ${hash.toHex()}`);
                
                // Wait longer between transactions to avoid nonce issues
                await new Promise(resolve => setTimeout(resolve, 5000));
                
                console.log(`✅ Transfer ${i + 1}/${accountsNeedingFunds.length} submitted successfully!`);
                successfulTransfers++;
                
            } catch (error) {
                console.error(`❌ Transfer ${i + 1}/${accountsNeedingFunds.length} failed:`, error.message);
                failedTransfers++;
                
                // Wait a bit even on failure before next attempt
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
        
        console.log('\n⏳ Waiting 10 seconds for transactions to be processed...');
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // Check final balances using zkVerifySession
        console.log('\n💰 Checking final balances...');
        const finalAccountInfo = await session.getAccountInfo();
        
        console.log('\n📊 Transfer Summary:');
        console.log(`   Successful: ${successfulTransfers}/${accountsNeedingFunds.length}`);
        console.log(`   Failed: ${failedTransfers}/${accountsNeedingFunds.length}`);
        console.log(`   Total sent: ${successfulTransfers * 1000} VOL`);
        
        console.log('\n📊 Final Account Balances:');
        finalAccountInfo.forEach((account, index) => {
            const balanceVOL = (BigInt(account.freeBalance) / BigInt('1000000000000000000')).toString();
            const statusIcon = index === 0 ? '🏦' : (Number(balanceVOL) >= 200 ? '✅' : '❌');
            const accountType = index === 0 ? '(Base)' : `(Derived ${index})`;
            console.log(`   ${statusIcon} Account ${index + 1} ${accountType} (${account.address.slice(0, 8)}...): ${balanceVOL} VOL`);
        });
        
        // Save results
        const fs = require('fs');
        if (!fs.existsSync('./data')) {
            fs.mkdirSync('./data');
        }
        
        const fundingData = {
            baseAccount: baseAddress,
            transferAmount: "1000 VOL each",
            accountsNeedingFunds: accountsNeedingFunds,
            transferResults: {
                successful: successfulTransfers,
                failed: failedTransfers,
                total: accountsNeedingFunds.length
            },
            finalBalances: finalAccountInfo.map(acc => ({
                address: acc.address,
                balance: acc.freeBalance,
                balanceVOL: (BigInt(acc.freeBalance) / BigInt('1000000000000000000')).toString(),
                hasEnoughFunds: Number((BigInt(acc.freeBalance) / BigInt('1000000000000000000')).toString()) >= 200
            })),
            timestamp: new Date().toISOString()
        };
        
        fs.writeFileSync('./data/funding-results-simple.json', JSON.stringify(fundingData, null, 2));
        console.log('\n💾 Funding results saved to ./data/funding-results-simple.json');
        
        // Check if all accounts now have enough funds
        const accountsWithEnoughFunds = finalAccountInfo.filter((acc, idx) => 
            idx === 0 || Number((BigInt(acc.freeBalance) / BigInt('1000000000000000000')).toString()) >= 200
        ).length;
        
        const totalDerivedAccounts = finalAccountInfo.length - 1; // Exclude base account
        const derivedAccountsWithEnoughFunds = accountsWithEnoughFunds - 1; // Exclude base account
        
        if (derivedAccountsWithEnoughFunds === totalDerivedAccounts) {
            console.log('\n🎉 All derived accounts now have sufficient funds (≥200 VOL)!');
            console.log('✅ Ready for parallel proof submission with 8 accounts!');
        } else {
            console.log(`\n⚠️  ${derivedAccountsWithEnoughFunds}/${totalDerivedAccounts} derived accounts have sufficient funds.`);
            console.log('🔄 You may need to run this script again to fund the remaining accounts.');
        }
        
        // Cleanup
        await api.disconnect();
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Error funding derived accounts:', error.message);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT. Shutting down gracefully...');
    process.exit(0);
});

fundDerivedAccountsSimple();