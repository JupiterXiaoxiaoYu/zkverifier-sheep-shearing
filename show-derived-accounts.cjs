const { zkVerifySession } = require("zkverifyjs");
const dotenv = require('dotenv');

dotenv.config();

async function showDerivedAccounts() {
    try {
        console.log('🔍 Showing derived accounts from seed phrase...');
        
        // Initialize session with base account
        const session = await zkVerifySession.start().Volta().withAccount(process.env.SEED_PHRASE);
        
        // Get base account info
        const initialAccountInfo = await session.getAccountInfo();
        const baseAddress = initialAccountInfo[0].address;
        
        console.log('\n📍 Base Account:');
        console.log(`   Address: ${baseAddress}`);
        console.log(`   Balance: ${initialAccountInfo[0].freeBalance}`);
        console.log(`   Nonce: ${initialAccountInfo[0].nonce}`);
        
        // Derive 7 additional accounts (total 8)
        console.log('\n🔄 Deriving 7 additional accounts...');
        const derivedAddresses = await session.addDerivedAccounts(baseAddress, 7);
        
        console.log(`✅ Successfully derived ${derivedAddresses.length} accounts`);
        
        // Get all account information
        const allAccountInfo = await session.getAccountInfo();
        
        console.log('\n👥 All 8 Derived Accounts:');
        console.log('=' .repeat(80));
        
        allAccountInfo.forEach((account, index) => {
            console.log(`Account ${index + 1}:`);
            console.log(`   Address: ${account.address}`);
            console.log(`   Balance: ${account.freeBalance} VOL`);
            console.log(`   Reserved: ${account.reservedBalance} VOL`);
            console.log(`   Nonce: ${account.nonce}`);
            
            if (index === 0) {
                console.log(`   Type: Base account (from seed phrase)`);
            } else {
                console.log(`   Type: Derived account (child of base)`);
            }
            console.log('');
        });
        
        console.log('=' .repeat(80));
        console.log(`🎯 Total accounts ready for parallel proof submission: ${allAccountInfo.length}`);
        
        // Save account info to file for reference
        const accountData = {
            baseAccount: baseAddress,
            derivedAccounts: derivedAddresses,
            allAccounts: allAccountInfo.map(acc => ({
                address: acc.address,
                balance: acc.freeBalance,
                reserved: acc.reservedBalance,
                nonce: acc.nonce
            })),
            timestamp: new Date().toISOString()
        };
        
        const fs = require('fs');
        if (!fs.existsSync('./data')) {
            fs.mkdirSync('./data');
        }
        
        fs.writeFileSync('./data/derived-accounts.json', JSON.stringify(accountData, null, 2));
        console.log('💾 Account information saved to ./data/derived-accounts.json');
        
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Error showing derived accounts:', error.message);
        process.exit(1);
    }
}

showDerivedAccounts();