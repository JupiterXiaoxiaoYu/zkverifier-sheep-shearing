const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { zkVerifySession, Library, CurveType, ZkVerifyEvents } = require("zkverifyjs");
const dotenv = require('dotenv');
const HealthServer = require('./health-server.cjs');

dotenv.config();

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message || error);
    console.log('🔄 Process will continue...');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    console.log('🔄 Process will continue...');
});

class RapidsnarkSHA256Pipeline {
    constructor() {
        // SHA256 circuit paths (k≈19.98, 1,031,716 constraints)
        this.proverPath = './rapidsnark-prover';
        this.zkeyPath = './k20/sha256_k20_0000.zkey';
        this.wasmPath = './k20/sha256_k20_js/sha256_k20.wasm';
        this.verificationKeyPath = './k20/sha256_k20_vkey.json';
        
        // Temporary file paths
        this.tempDir = '/tmp';
        
        // zkVerify configuration
        this.session = null;
        this.accountSeed = process.env.SEED_PHRASE;
        this.derivedAccounts = [];
        this.accountCount = 8; // Number of parallel accounts
        
        // Health server for Railway monitoring
        this.healthServer = new HealthServer(process.env.PORT || 8080);
        
        // Statistics
        this.stats = {
            totalAttempts: 0,
            successful: 0,
            failed: 0,
            startTime: Date.now(),
            accountStats: {} // Track stats per account
        };
        
        this.loadVerificationKey();
    }
    
    loadVerificationKey() {
        try {
            const vkData = fs.readFileSync(this.verificationKeyPath, 'utf8');
            this.verificationKey = JSON.parse(vkData);
            console.log('✅ SHA256 verification key loaded successfully');
            console.log(`📋 Protocol: ${this.verificationKey.protocol}, Curve: ${this.verificationKey.curve}`);
            console.log(`🔢 Public inputs: ${this.verificationKey.nPublic}, Circuit size: k≈18 (281,376 constraints)`);
        } catch (error) {
            console.error('❌ Failed to load verification key:', error.message);
            throw error;
        }
    }
    
    async initializeSession() {
        try {
            console.log('🚀 Initializing automated proof pipeline with 8 parallel accounts...');
            
            // Debug environment variables
            console.log('🔍 Environment debug:');
            console.log(`   NODE_ENV: ${process.env.NODE_ENV}`);
            console.log(`   PORT: ${process.env.PORT}`);
            console.log(`   SEED_PHRASE exists: ${!!process.env.SEED_PHRASE}`);
            console.log(`   All env vars count: ${Object.keys(process.env).length}`);
            
            // Validate seed phrase before starting
            if (!this.accountSeed) {
                console.error('❌ SEED_PHRASE is undefined');
                console.error('📋 Available environment variables:', Object.keys(process.env).filter(k => !k.includes('PATH')).slice(0, 10));
                throw new Error('SEED_PHRASE environment variable is not set. Please configure it in Railway dashboard.');
            }
            
            console.log(`🔑 Using seed phrase starting with: ${this.accountSeed.split(' ')[0]}...`);
            
            // Start health server for Railway monitoring
            this.healthServer.start();
            
            // Initialize session with base account
            this.session = await zkVerifySession.start().Volta().withAccount(this.accountSeed);
            
            // Get base account address
            const accountInfo = await this.session.getAccountInfo();
            const baseAddress = accountInfo[0].address;
            console.log(`📍 Base account: ${baseAddress}`);
            
            // Derive additional accounts for parallel processing
            console.log(`🔄 Deriving ${this.accountCount - 1} additional accounts...`);
            const derivedAddresses = await this.session.addDerivedAccounts(baseAddress, this.accountCount - 1);
            
            // Store all account addresses (base + derived)
            this.derivedAccounts = [baseAddress, ...derivedAddresses];
            
            console.log(`✅ ${this.derivedAccounts.length} accounts ready for parallel processing:`);
            this.derivedAccounts.forEach((address, index) => {
                console.log(`   Account ${index + 1}: ${address}`);
                this.stats.accountStats[address] = { submitted: 0, successful: 0, failed: 0 };
            });
            
            // Set up event listeners
            this.setupEventListeners();
            
            console.log('✅ Pipeline initialized successfully');
            return true;
        } catch (error) {
            console.error('❌ Failed to initialize zkVerify session:', error.message);
            return false;
        }
    }
    
    setupEventListeners() {
        this.session.subscribe([
            {
                event: ZkVerifyEvents.NewAggregationReceipt,
                callback: async (eventData) => {
                    console.log("📧 New aggregation receipt received:", {
                        domainId: eventData.data.domainId,
                        aggregationId: eventData.data.aggregationId,
                        blockHash: eventData.blockHash
                    });
                    
                    // Save aggregation data for future reference
                    try {
                        if (!fs.existsSync('./data')) {
                            fs.mkdirSync('./data');
                        }
                        
                        const aggregationData = {
                            blockHash: eventData.blockHash,
                            domainId: parseInt(eventData.data.domainId),
                            aggregationId: parseInt(eventData.data.aggregationId.replace(/,/g, '')),
                            timestamp: new Date().toISOString()
                        };
                        
                        fs.writeFileSync(
                            `./data/aggregation_${aggregationData.aggregationId}.json`, 
                            JSON.stringify(aggregationData, null, 2)
                        );
                        
                        console.log(`💾 Aggregation data saved for ID: ${aggregationData.aggregationId}`);
                    } catch (error) {
                        console.error('❌ Error saving aggregation data:', error);
                    }
                },
                options: { domainId: 0 },
            },
        ]);
    }
    
    generateRandomSHA256Input() {
        // Generate random 16384-bit input for SHA256 k20
        const input = [];
        for (let i = 0; i < 16384; i++) {
            input.push(Math.floor(Math.random() * 2)); // Random 0 or 1
        }
        return input;
    }
    
    getAccountTempPaths(accountIndex) {
        // Create unique temp file paths for each account
        return {
            witnessPath: path.join(this.tempDir, `sha256_witness_${accountIndex}.wtns`),
            proofPath: path.join(this.tempDir, `rapidsnark_sha256_proof_${accountIndex}.json`),
            publicPath: path.join(this.tempDir, `rapidsnark_sha256_public_${accountIndex}.json`),
            inputFile: path.join(this.tempDir, `sha256_input_${accountIndex}.json`)
        };
    }
    
    async generateWitnessWithSnarkjs(input, accountIndex) {
        return new Promise((resolve, reject) => {
            console.log(`🔨 Generating witness for account ${accountIndex + 1}...`);
            
            const paths = this.getAccountTempPaths(accountIndex);
            
            // Create input file
            fs.writeFileSync(paths.inputFile, JSON.stringify({ in: input }));
            
            // Generate witness using snarkjs
            const snarkjs = spawn('npx', [
                'snarkjs',
                'wtns',
                'calculate',
                this.wasmPath,
                paths.inputFile,
                paths.witnessPath
            ]);
            
            let stderr = '';
            snarkjs.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            
            snarkjs.on('close', (code) => {
                if (code === 0) {
                    console.log(`✅ Witness generated successfully for account ${accountIndex + 1}`);
                    resolve(input);
                } else {
                    reject(new Error(`Witness generation failed with code ${code}. Error: ${stderr}`));
                }
            });
            
            snarkjs.on('error', (error) => {
                reject(new Error(`Failed to start witness generation: ${error.message}`));
            });
        });
    }
    
    async generateProofWithRapidsnark(accountIndex) {
        return new Promise((resolve, reject) => {
            console.log(`⚡ Generating proof with rapidsnark for account ${accountIndex + 1}...`);
            
            const paths = this.getAccountTempPaths(accountIndex);
            
            // Clean up previous temp files
            [paths.proofPath, paths.publicPath].forEach(filePath => {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            });
            
            const prover = spawn(this.proverPath, [
                this.zkeyPath,
                paths.witnessPath,
                paths.proofPath,
                paths.publicPath
            ]);
            
            let stderr = '';
            
            prover.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            
            prover.on('close', (code) => {
                if (code === 0) {
                    try {
                        // Read and clean generated proof and public inputs
                        const proofRaw = fs.readFileSync(paths.proofPath, 'utf8').replace(/\0/g, '').trim();
                        const publicRaw = fs.readFileSync(paths.publicPath, 'utf8').replace(/\0/g, '').trim();
                        
                        const proofData = JSON.parse(proofRaw);
                        const publicInputsRaw = JSON.parse(publicRaw);
                        // Keep as string array for zkVerify compatibility
                        const publicInputs = publicInputsRaw;
                        
                        console.log(`✅ Proof generated successfully for account ${accountIndex + 1}!`);
                        console.log(`📋 Public signals: [${publicInputs.slice(0, 3).join(', ')}...] (${publicInputs.length} total)`);
                        
                        resolve({
                            proof: proofData,
                            publicInputs: publicInputs
                        });
                    } catch (readError) {
                        reject(new Error(`Failed to read generated files: ${readError.message}`));
                    }
                } else {
                    reject(new Error(`Rapidsnark prover exited with code ${code}. Error: ${stderr}`));
                }
            });
            
            prover.on('error', (error) => {
                reject(new Error(`Failed to start rapidsnark prover: ${error.message}`));
            });
        });
    }
    
    async submitProof(proofData, publicInputs, mockInputSummary, accountAddress, accountIndex) {
        const maxRetries = 3;
        let retryCount = 0;
        
        while (retryCount < maxRetries) {
            try {
                console.log(`🔢 Submitting proof from account ${accountIndex + 1} (${accountAddress.slice(0, 8)}...)...${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);
                
                // Submit to zkVerify with promise wrapper to catch async errors
                const submissionPromise = new Promise(async (resolve, reject) => {
                    try {
                        const { events } = await this.session.verify(accountAddress)
                            .groth16({library: Library.snarkjs, curve: CurveType.bn128})
                            .execute({
                                proofData: {
                                    vk: this.verificationKey,
                                    proof: proofData,
                                    publicSignals: publicInputs
                                }, 
                                domainId: 0
                            });

                        // Handle submission events
                        events.on(ZkVerifyEvents.IncludedInBlock, (eventData) => {
                            console.log(`✅ Proof from account ${accountIndex + 1} included in block:`, {
                                account: `${accountAddress.slice(0, 8)}...`,
                                statement: eventData.statement,
                                aggregationId: eventData.aggregationId,
                                inputSummary: mockInputSummary
                            });
                            
                            // Update account-specific stats
                            this.stats.accountStats[accountAddress].successful++;
                            
                            // Save submission details
                            try {
                                if (!fs.existsSync('./data')) {
                                    fs.mkdirSync('./data');
                                }
                                
                                const submissionData = {
                                    account: accountAddress,
                                    accountIndex: accountIndex + 1,
                                    inputSummary: mockInputSummary,
                                    statement: eventData.statement,
                                    aggregationId: eventData.aggregationId,
                                    timestamp: new Date().toISOString(),
                                    publicSignalsCount: publicInputs.length,
                                    circuitSize: "k≈20 (1,031,716 constraints)"
                                };
                                
                                fs.writeFileSync(
                                    `./data/sha256_submission_${this.stats.totalAttempts}.json`, 
                                    JSON.stringify(submissionData, null, 2)
                                );
                            } catch (saveError) {
                                console.error('❌ Error saving submission data:', saveError);
                            }
                            
                            resolve(true);
                        });

                        // Handle errors in events
                        events.on('error', (error) => {
                            reject(error);
                        });

                        // Set timeout for the submission
                        setTimeout(() => {
                            reject(new Error('Submission timeout after 20 seconds'));
                        }, 20000);

                    } catch (error) {
                        reject(error);
                    }
                });

                // Wait for submission to complete
                await submissionPromise;
                return; // Success, exit retry loop
                
            } catch (error) {
                retryCount++;
                let errorMessage = 'Unknown error';
                if (error && typeof error === 'object') {
                    errorMessage = error.message || JSON.stringify(error) || error.toString();
                } else if (error) {
                    errorMessage = error.toString();
                }
                console.error(`❌ Error submitting proof #${this.stats.totalAttempts} (attempt ${retryCount}):`, errorMessage);
                
                // Check for specific errors that should trigger retry
                const shouldRetry = 
                    errorMessage.includes('Priority is too low') ||
                    errorMessage.includes('already in the pool') ||
                    errorMessage.includes('disconnected') ||
                    errorMessage.includes('Abnormal Closure') ||
                    errorMessage.includes('Connection') ||
                    errorMessage.includes('timeout') ||
                    errorMessage.includes('1014:');
                
                if (shouldRetry && retryCount < maxRetries) {
                    console.log(`⏳ Waiting 5 seconds before retry...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    
                    // Try to reconnect session if it's a connection error
                    if (errorMessage.includes('disconnected') || errorMessage.includes('Abnormal Closure')) {
                        console.log('🔄 Attempting to reconnect session...');
                        try {
                            this.session = await zkVerifySession.start().Volta().withAccount(this.accountSeed);
                            this.setupEventListeners();
                            console.log('✅ Session reconnected successfully');
                        } catch (reconnectError) {
                            console.error('❌ Failed to reconnect session:', reconnectError?.message || reconnectError);
                        }
                    }
                } else {
                    // Either not a retryable error or max retries reached
                    if (retryCount >= maxRetries) {
                        console.error(`❌ Max retries (${maxRetries}) reached for proof #${this.stats.totalAttempts}`);
                    }
                    // Don't throw error, just log and continue with next proof
                    break;
                }
            }
        }
    }
    
    async runSingleProofCycle(accountIndex) {
        const accountAddress = this.derivedAccounts[accountIndex];
        this.stats.accountStats[accountAddress].submitted++;
        
        try {
            console.log(`\n🔄 Starting SHA256 proof for account ${accountIndex + 1} (${accountAddress.slice(0, 8)}...)`);
            
            // Step 1: Generate random input for SHA256
            const randomInput = this.generateRandomSHA256Input();
            const inputSummary = {
                totalBits: randomInput.length,
                onesCount: randomInput.filter(bit => bit === 1).length,
                zerosCount: randomInput.filter(bit => bit === 0).length,
                firstBytes: randomInput.slice(0, 32).join('')
            };
            
            console.log(`🎲 Generated random ${randomInput.length}-bit input for account ${accountIndex + 1}: ${inputSummary.onesCount} ones, ${inputSummary.zerosCount} zeros`);
            
            // Step 2: Generate witness
            await this.generateWitnessWithSnarkjs(randomInput, accountIndex);
            
            // Step 3: Generate proof with rapidsnark
            const { proof, publicInputs } = await this.generateProofWithRapidsnark(accountIndex);
            
            // Step 4: Submit proof to zkVerify
            await this.submitProof(proof, publicInputs, inputSummary, accountAddress, accountIndex);
            
            console.log(`✅ SHA256 proof cycle completed successfully for account ${accountIndex + 1}!\n`);
            
        } catch (error) {
            this.stats.accountStats[accountAddress].failed++;
            let errorMessage;
            
            try {
                errorMessage = error?.message || JSON.stringify(error) || error.toString();
            } catch (stringifyError) {
                errorMessage = 'Unknown error occurred';
            }
            
            console.error(`❌ SHA256 proof cycle failed for account ${accountIndex + 1}: ${errorMessage}\n`);
            throw error;
        }
    }
    
    async runParallelProofCycles() {
        console.log(`\n🚀 Starting parallel proof generation across ${this.derivedAccounts.length} accounts...`);
        
        // Create promises for all accounts
        const proofPromises = this.derivedAccounts.map(async (accountAddress, index) => {
            try {
                await this.runSingleProofCycle(index);
                this.stats.successful++;
            } catch (error) {
                this.stats.failed++;
                // Error already logged in runSingleProofCycle
            }
        });
        
        // Wait for all proofs to complete
        await Promise.all(proofPromises);
        
        this.stats.totalAttempts += this.derivedAccounts.length;
        
        // Print summary statistics
        console.log(`\n📊 Parallel cycle completed:`);
        console.log(`   Total attempts this cycle: ${this.derivedAccounts.length}`);
        console.log(`   Successful: ${this.stats.successful}`);
        console.log(`   Failed: ${this.stats.failed}`);
        
        // Print per-account statistics
        console.log(`\n📈 Account Statistics:`);
        this.derivedAccounts.forEach((address, index) => {
            const stats = this.stats.accountStats[address];
            console.log(`   Account ${index + 1} (${address.slice(0, 8)}...): ${stats.successful}/${stats.submitted} successful (${stats.submitted > 0 ? ((stats.successful / stats.submitted) * 100).toFixed(1) : 0}%)`);
        });
        
        // Update health server statistics
        this.healthServer.updateProofStats(this.stats.totalAttempts, this.stats.successful, this.stats.failed);
    }
    
    async runContinuous(intervalSeconds = 30) {
        console.log(`🔄 Starting continuous parallel SHA256 proof submission every ${intervalSeconds} seconds...`);
        console.log(`🧮 Circuit: SHA256 (k≈20, 1,031,716 constraints, 16384-bit input)`);
        console.log(`👥 Using ${this.derivedAccounts.length} parallel accounts`);
        
        const runCycle = async () => {
            try {
                await this.runParallelProofCycles();
                
                // Note: Aggregation receipts will arrive asynchronously and be logged when received
                
            } catch (error) {
                console.error('❌ Error in parallel proof cycle:', error);
                // Continue with next cycle
            }
            
            // Calculate runtime statistics
            const runtime = Math.floor((Date.now() - this.stats.startTime) / 1000);
            const hours = Math.floor(runtime / 3600);
            const minutes = Math.floor((runtime % 3600) / 60);
            const seconds = runtime % 60;
            
            console.log(`📈 Runtime: ${hours}h ${minutes}m ${seconds}s | Success: ${this.stats.successful} | Failed: ${this.stats.failed}`);
            console.log(`⏳ Next parallel proof cycle in ${intervalSeconds} seconds...`);
            
            setTimeout(runCycle, intervalSeconds * 1000);
        };
        
        // Start first cycle
        runCycle();
    }
    
    async runSingle() {
        try {
            await this.runParallelProofCycles();
            console.log('✅ Single parallel SHA256 proof submission completed');
            process.exit(0);
        } catch (error) {
            console.error('❌ Single parallel SHA256 proof submission failed');
            process.exit(1);
        }
    }
}

// Main execution
async function main() {
    pipeline = new RapidsnarkSHA256Pipeline();
    const args = process.argv.slice(2);
    
    // Initialize session and event listeners first
    if (!await pipeline.initializeSession()) {
        console.error('❌ Failed to initialize zkVerify session. Exiting.');
        process.exit(1);
    }
    
    if (args.includes('--continuous')) {
        const intervalIndex = args.indexOf('--interval');
        const interval = intervalIndex !== -1 && args[intervalIndex + 1] ? 
                        parseInt(args[intervalIndex + 1]) : 30;
        
        await pipeline.runContinuous(interval);
    } else {
        await pipeline.runSingle();
    }
}

// Handle graceful shutdown
let pipeline = null;

process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT. Shutting down gracefully...');
    if (pipeline && pipeline.healthServer) {
        pipeline.healthServer.stop();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM. Shutting down gracefully...');
    if (pipeline && pipeline.healthServer) {
        pipeline.healthServer.stop();
    }
    process.exit(0);
});

main().catch((error) => {
    console.error('❌ Fatal error in main:', error.message || error);
    process.exit(1);
});