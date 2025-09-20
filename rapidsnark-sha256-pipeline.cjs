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
        // Use Railway's persistent volume for caching large files
        this.cacheDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || './cache';
        
        // SHA256 circuit paths (k≈19.98, 1,031,716 constraints)  
        this.proverPath = './rapidsnark-prover';
        this.zkeyPath = path.join(this.cacheDir, 'sha256_k20_0000.zkey');
        this.wasmPath = './k20/sha256_k20_js/sha256_k20.wasm';
        this.verificationKeyPath = './k20/sha256_k20_vkey.json';
        
        // Fallback paths if cache doesn't exist
        this.fallbackZkeyPath = './k20/sha256_k20_0000.zkey';
        this.downloadedZkeyPath = '/app/downloaded_files/sha256_k20_0000.zkey';
        
        // Ensure rapidsnark-prover has execute permissions
        this.ensureProverPermissions();
        
        // Temporary file paths
        this.tempDir = '/tmp';
        
        // zkVerify configuration
        this.session = null;
        this.accountSeed = process.env.SEED_PHRASE;
        this.derivedAccounts = [];
        this.accountCount = 8; // Account 1 does triple proof, others do single proof
        
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
    
    ensureProverPermissions() {
        try {
            // Check if prover exists and set execute permissions
            if (fs.existsSync(this.proverPath)) {
                fs.chmodSync(this.proverPath, 0o755);
                console.log('✅ Rapidsnark prover permissions set to executable');
            } else {
                console.error('❌ Rapidsnark prover not found at:', this.proverPath);
            }
        } catch (error) {
            console.error('⚠️ Failed to set prover permissions:', error.message);
        }
    }
    
    async ensureCircuitFiles() {
        try {
            console.log('🔍 Checking circuit files...');
            console.log(`📁 Cache directory: ${this.cacheDir}`);
            
            const expectedSize = 541519920; // 516MB
            
            // Check if cached version exists first
            if (fs.existsSync(this.zkeyPath)) {
                const stats = fs.statSync(this.zkeyPath);
                if (stats.size === expectedSize) {
                    console.log('✅ Cached zkey file found and verified');
                    return;
                } else {
                    console.log(`⚠️ Cached zkey file wrong size: ${stats.size} vs expected ${expectedSize}`);
                }
            }
            
            // Check the Git LFS file
            if (fs.existsSync(this.fallbackZkeyPath)) {
                const stats = fs.statSync(this.fallbackZkeyPath);
                console.log(`📋 Git LFS zkey file size: ${stats.size} bytes`);
                
                if (stats.size === expectedSize) {
                    console.log('✅ Git LFS file is correct, setting up cache...');
                    
                    // Ensure cache directory exists
                    if (!fs.existsSync(this.cacheDir)) {
                        fs.mkdirSync(this.cacheDir, { recursive: true });
                        console.log(`📁 Created cache directory: ${this.cacheDir}`);
                    }
                    
                    // Copy to cache for faster access next time
                    console.log('📥 Copying Git LFS file to cache...');
                    fs.copyFileSync(this.fallbackZkeyPath, this.zkeyPath);
                    console.log('✅ Zkey file cached successfully');
                    return;
                    
                } else if (stats.size < 1000) {
                    // This is a Git LFS pointer file, check for downloaded file
                    const content = fs.readFileSync(this.fallbackZkeyPath, 'utf8');
                    console.log('❌ Git LFS pointer detected (file not downloaded):');
                    console.log(content.substring(0, 200));
                    
                    // Check if we have a downloaded file from build process
                    if (fs.existsSync(this.downloadedZkeyPath)) {
                        const downloadedStats = fs.statSync(this.downloadedZkeyPath);
                        console.log(`📥 Found downloaded file: ${downloadedStats.size} bytes`);
                        
                        if (downloadedStats.size === expectedSize) {
                            console.log('✅ Downloaded file is correct, setting up cache...');
                            
                            // Ensure cache directory exists
                            if (!fs.existsSync(this.cacheDir)) {
                                fs.mkdirSync(this.cacheDir, { recursive: true });
                                console.log(`📁 Created cache directory: ${this.cacheDir}`);
                            }
                            
                            // Copy downloaded file to cache
                            console.log('📥 Copying downloaded file to cache...');
                            fs.copyFileSync(this.downloadedZkeyPath, this.zkeyPath);
                            console.log('✅ Zkey file cached successfully from download');
                            return;
                        } else {
                            console.log(`⚠️ Downloaded file wrong size: ${downloadedStats.size} vs expected ${expectedSize}`);
                        }
                    } else {
                        console.log('❌ No downloaded file found at:', this.downloadedZkeyPath);
                    }
                    
                    throw new Error('Git LFS file not downloaded and no valid downloaded file found. Check build process.');
                } else {
                    console.log(`⚠️ Git LFS file wrong size: ${stats.size} vs expected ${expectedSize}`);
                    throw new Error(`Git LFS file corrupted or incomplete: ${stats.size} bytes`);
                }
            } else {
                throw new Error(`Git LFS file missing: ${this.fallbackZkeyPath}`);
            }
            
        } catch (error) {
            console.error('❌ Failed to ensure circuit files:', error.message);
            throw error;
        }
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
            
            // Ensure circuit files are available (download if needed)
            await this.ensureCircuitFiles();
            
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
            
            console.log(`✅ ${this.derivedAccounts.length} accounts ready - Account 1 triple proof, others single proof:`);
            this.derivedAccounts.forEach((address, index) => {
                const mode = index === 0 ? '(triple proof)' : '(single proof)';
                console.log(`   Account ${index + 1}: ${address} ${mode}`);
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
    
    async submitProof(proofData, publicInputs, mockInputSummary, accountAddress, accountIndex, proofType = '') {
        const maxRetries = 3;
        let retryCount = 0;
        
        while (retryCount < maxRetries) {
            try {
                const proofLabel = proofType ? ` ${proofType}` : '';
                console.log(`🔢 Submitting proof${proofLabel} from account ${accountIndex + 1} (${accountAddress.slice(0, 8)}...)...${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);
                
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
                            console.log(`✅ Proof${proofLabel} from account ${accountIndex + 1} included in block:`, {
                                account: `${accountAddress.slice(0, 8)}...`,
                                statement: eventData.statement,
                                aggregationId: eventData.aggregationId,
                                inputSummary: mockInputSummary
                            });
                            
                            // Note: Account-specific stats updated in monitorAsyncSubmissions
                            
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
                const proofLabel = proofType ? ` ${proofType}` : '';
                let errorMessage = 'Unknown error';
                if (error && typeof error === 'object') {
                    errorMessage = error.message || JSON.stringify(error) || error.toString();
                } else if (error) {
                    errorMessage = error.toString();
                }
                console.error(`❌ Error submitting proof${proofLabel} #${this.stats.totalAttempts} from account ${accountIndex + 1} (attempt ${retryCount}):`, errorMessage);
                
                // Check for specific errors that should trigger retry
                const shouldRetry = 
                    errorMessage.includes('Priority is too low') ||
                    errorMessage.includes('already in the pool') ||
                    errorMessage.includes('disconnected') ||
                    errorMessage.includes('Abnormal Closure') ||
                    errorMessage.includes('Connection') ||
                    errorMessage.includes('timeout') ||
                    errorMessage.includes('not found in session') ||
                    errorMessage.includes('1014:');
                
                if (shouldRetry && retryCount < maxRetries) {
                    console.log(`⏳ Waiting 5 seconds before retry...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    
                    // Try to reconnect session if it's a connection error
                    if (errorMessage.includes('disconnected') || errorMessage.includes('Abnormal Closure') || errorMessage.includes('not found in session')) {
                        console.log('🔄 Attempting to reconnect session with derived accounts...');
                        try {
                            await this.reconnectSessionWithDerivedAccounts();
                            console.log('✅ Session and derived accounts reconnected successfully');
                        } catch (reconnectError) {
                            console.error('❌ Failed to reconnect session:', reconnectError?.message || reconnectError);
                        }
                    }
                } else {
                    // Either not a retryable error or max retries reached
                    if (retryCount >= maxRetries) {
                        console.error(`❌ Max retries (${maxRetries}) reached for proof${proofLabel} #${this.stats.totalAttempts} from account ${accountIndex + 1}`);
                    }
                    // Don't throw error, just log and continue with next proof
                    break;
                }
            }
        }
    }
    
    async runSingleProofCycleStaggered(accountIndex, batchId = '') {
        const accountAddress = this.derivedAccounts[accountIndex];
        this.stats.accountStats[accountAddress].submitted++;
        
        try {
            const startTime = Date.now();
            console.log(`\n🔄 [${new Date().toLocaleTimeString()}] Starting SHA256 proof for account ${accountIndex + 1} (${accountAddress.slice(0, 8)}...) [${batchId}]`);
            
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
            const witnessStart = Date.now();
            console.log(`🔧 [${new Date().toLocaleTimeString()}] [${batchId}] Witness generation phase for account ${accountIndex + 1}`);
            await this.generateWitnessWithSnarkjs(randomInput, accountIndex);
            const witnessTime = Date.now() - witnessStart;
            console.log(`✅ [${new Date().toLocaleTimeString()}] [${batchId}] Witness completed for account ${accountIndex + 1} (${witnessTime}ms)`);
            
            // Step 3: Generate proof with rapidsnark  
            const proofStart = Date.now();
            console.log(`⚡ [${new Date().toLocaleTimeString()}] [${batchId}] Proof generation phase for account ${accountIndex + 1}`);
            const { proof, publicInputs } = await this.generateProofWithRapidsnark(accountIndex);
            const proofTime = Date.now() - proofStart;
            console.log(`✅ [${new Date().toLocaleTimeString()}] [${batchId}] Proof completed for account ${accountIndex + 1} (${proofTime}ms)`);
            
            // Step 4: Submit proof to zkVerify
            const submitStart = Date.now();
            console.log(`📤 [${new Date().toLocaleTimeString()}] [${batchId}] Proof submission phase for account ${accountIndex + 1}`);
            await this.submitProof(proof, publicInputs, inputSummary, accountAddress, accountIndex, 'Single');
            const submitTime = Date.now() - submitStart;
            const totalTime = Date.now() - startTime;
            
            console.log(`✅ [${new Date().toLocaleTimeString()}] [${batchId}] SHA256 proof cycle completed for account ${accountIndex + 1}!`);
            console.log(`⏱️ [${batchId}] Timing - Witness: ${witnessTime}ms, Proof: ${proofTime}ms, Submit: ${submitTime}ms, Total: ${totalTime}ms\n`);
            
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
    
    async runSingleProofCycle(accountIndex) {
        return this.runSingleProofCycleStaggered(accountIndex, '');
    }
    
    async runSingleProofCycleAsync(accountIndex, batchId = '') {
        const accountAddress = this.derivedAccounts[accountIndex];
        
        try {
            const startTime = Date.now();
            console.log(`\n🔄 [${new Date().toLocaleTimeString()}] Starting single SHA256 proof for account ${accountIndex + 1} (${accountAddress.slice(0, 8)}...) [${batchId}]`);
            
            // Generate random input for SHA256
            const randomInput = this.generateRandomSHA256Input();
            const inputSummary = {
                totalBits: randomInput.length,
                onesCount: randomInput.filter(bit => bit === 1).length,
                zerosCount: randomInput.filter(bit => bit === 0).length,
                firstBytes: randomInput.slice(0, 32).join('')
            };
            
            console.log(`🎲 Generated random ${randomInput.length}-bit input for account ${accountIndex + 1}: ${inputSummary.onesCount} ones, ${inputSummary.zerosCount} zeros`);
            
            // Generate witness
            const witnessStart = Date.now();
            console.log(`🔧 [${new Date().toLocaleTimeString()}] [${batchId}] Witness generation phase for account ${accountIndex + 1}`);
            await this.generateWitnessWithSnarkjs(randomInput, accountIndex);
            const witnessTime = Date.now() - witnessStart;
            console.log(`✅ [${new Date().toLocaleTimeString()}] [${batchId}] Witness completed for account ${accountIndex + 1} (${witnessTime}ms)`);
            
            // Generate proof with rapidsnark  
            const proofStart = Date.now();
            console.log(`⚡ [${new Date().toLocaleTimeString()}] [${batchId}] Proof generation phase for account ${accountIndex + 1}`);
            const { proof, publicInputs } = await this.generateProofWithRapidsnark(accountIndex);
            const proofTime = Date.now() - proofStart;
            console.log(`✅ [${new Date().toLocaleTimeString()}] [${batchId}] Proof completed for account ${accountIndex + 1} (${proofTime}ms)`);
            
            // Submit proof asynchronously
            const submitStart = Date.now();
            console.log(`📤 [${new Date().toLocaleTimeString()}] [${batchId}] Proof submission initiated for account ${accountIndex + 1}`);
            
            const submitPromise = this.submitProof(proof, publicInputs, inputSummary, accountAddress, accountIndex, 'Single').then(() => {
                const submitTime = Date.now() - submitStart;
                console.log(`✅ [${new Date().toLocaleTimeString()}] [${batchId}] Proof submit completed for account ${accountIndex + 1} (${submitTime}ms)`);
                return { accountIndex, proofType: 'Single', success: true, submitTime };
            }).catch((error) => {
                const submitTime = Date.now() - submitStart;
                const errorMessage = error?.message || JSON.stringify(error) || error.toString();
                console.log(`❌ [${new Date().toLocaleTimeString()}] [${batchId}] Proof submit failed for account ${accountIndex + 1}: ${errorMessage}`);
                return { accountIndex, proofType: 'Single', success: false, error: errorMessage, submitTime };
            });
            
            const proofGenerationTime = Date.now() - startTime;
            console.log(`🚀 [${new Date().toLocaleTimeString()}] [${batchId}] Single proof generation completed for account ${accountIndex + 1} (${proofGenerationTime}ms)`);
            console.log(`⏱️ [${batchId}] Timing - Witness: ${witnessTime}ms, Proof: ${proofTime}ms, Total: ${proofGenerationTime}ms`);
            
            // Return submit promise for monitoring
            return submitPromise;
            
        } catch (error) {
            let errorMessage;
            
            try {
                errorMessage = error?.message || JSON.stringify(error) || error.toString();
            } catch (stringifyError) {
                errorMessage = 'Unknown error occurred';
            }
            
            console.error(`❌ Single SHA256 proof cycle failed for account ${accountIndex + 1}: ${errorMessage}\n`);
            throw error;
        }
    }
    
    async runTripleProofCycleAsync(accountIndex, batchId = '') {
        const accountAddress = this.derivedAccounts[accountIndex];
        this.stats.accountStats[accountAddress].submitted += 3; // 三个proof
        
        try {
            const startTime = Date.now();
            console.log(`\n🔄 [${new Date().toLocaleTimeString()}] Starting TRIPLE SHA256 proofs for account ${accountIndex + 1} (${accountAddress.slice(0, 8)}...) [${batchId}]`);
            
            // 生成三个不同的随机输入
            const randomInput1 = this.generateRandomSHA256Input();
            const randomInput2 = this.generateRandomSHA256Input();
            const randomInput3 = this.generateRandomSHA256Input();
            
            const inputSummary1 = {
                totalBits: randomInput1.length,
                onesCount: randomInput1.filter(bit => bit === 1).length,
                zerosCount: randomInput1.filter(bit => bit === 0).length,
                firstBytes: randomInput1.slice(0, 32).join('')
            };
            
            const inputSummary2 = {
                totalBits: randomInput2.length,
                onesCount: randomInput2.filter(bit => bit === 1).length,
                zerosCount: randomInput2.filter(bit => bit === 0).length,
                firstBytes: randomInput2.slice(0, 32).join('')
            };
            
            const inputSummary3 = {
                totalBits: randomInput3.length,
                onesCount: randomInput3.filter(bit => bit === 1).length,
                zerosCount: randomInput3.filter(bit => bit === 0).length,
                firstBytes: randomInput3.slice(0, 32).join('')
            };
            
            console.log(`🎲 Generated 3 random inputs for account ${accountIndex + 1}:`);
            console.log(`   Input A: ${inputSummary1.onesCount} ones, ${inputSummary1.zerosCount} zeros`);
            console.log(`   Input B: ${inputSummary2.onesCount} ones, ${inputSummary2.zerosCount} zeros`);
            console.log(`   Input C: ${inputSummary3.onesCount} ones, ${inputSummary3.zerosCount} zeros`);
            
            // 并行生成三个witness
            const witnessStart = Date.now();
            console.log(`🔧 [${new Date().toLocaleTimeString()}] [${batchId}] Triple witness generation phase for account ${accountIndex + 1}`);
            
            const [witness1, witness2, witness3] = await Promise.all([
                this.generateWitnessWithSnarkjs(randomInput1, accountIndex * 3),     // 使用不同的temp文件
                this.generateWitnessWithSnarkjs(randomInput2, accountIndex * 3 + 1), // 使用不同的temp文件
                this.generateWitnessWithSnarkjs(randomInput3, accountIndex * 3 + 2)  // 使用不同的temp文件
            ]);
            
            const witnessTime = Date.now() - witnessStart;
            console.log(`✅ [${new Date().toLocaleTimeString()}] [${batchId}] Triple witness completed for account ${accountIndex + 1} (${witnessTime}ms)`);
            
            // 并行生成三个proof
            const proofStart = Date.now();
            console.log(`⚡ [${new Date().toLocaleTimeString()}] [${batchId}] Triple proof generation phase for account ${accountIndex + 1}`);
            
            const [proof1Result, proof2Result, proof3Result] = await Promise.all([
                this.generateProofWithRapidsnark(accountIndex * 3),
                this.generateProofWithRapidsnark(accountIndex * 3 + 1),
                this.generateProofWithRapidsnark(accountIndex * 3 + 2)
            ]);
            
            const proofTime = Date.now() - proofStart;
            console.log(`✅ [${new Date().toLocaleTimeString()}] [${batchId}] Triple proof completed for account ${accountIndex + 1} (${proofTime}ms)`);
            
            // 立即提交第一个proof
            const submitStart1 = Date.now();
            console.log(`📤 [${new Date().toLocaleTimeString()}] [${batchId}] Proof A submission initiated for account ${accountIndex + 1} (immediate)`);
            
            const submitPromise1 = this.submitProof(proof1Result.proof, proof1Result.publicInputs, inputSummary1, accountAddress, accountIndex, 'A').then(() => {
                const submitTime = Date.now() - submitStart1;
                console.log(`✅ [${new Date().toLocaleTimeString()}] [${batchId}] Proof A submit completed for account ${accountIndex + 1} (${submitTime}ms)`);
                return { accountIndex, proofType: 'A', success: true, submitTime };
            }).catch((error) => {
                const submitTime = Date.now() - submitStart1;
                const errorMessage = error?.message || JSON.stringify(error) || error.toString();
                console.log(`❌ [${new Date().toLocaleTimeString()}] [${batchId}] Proof A submit failed for account ${accountIndex + 1}: ${errorMessage}`);
                return { accountIndex, proofType: 'A', success: false, error: errorMessage, submitTime };
            });
            
            // 延迟7秒提交第二个proof
            const submitStart2 = Date.now();
            console.log(`📤 [${new Date().toLocaleTimeString()}] [${batchId}] Proof B submission scheduled for account ${accountIndex + 1} (+7s delay)`);
            
            const submitPromise2 = new Promise(async (resolve) => {
                await new Promise(delay => setTimeout(delay, 7000)); // 7秒延迟
                const actualSubmitStart = Date.now();
                console.log(`📤 [${new Date().toLocaleTimeString()}] [${batchId}] Proof B submission initiated for account ${accountIndex + 1} (delayed)`);
                
                this.submitProof(proof2Result.proof, proof2Result.publicInputs, inputSummary2, accountAddress, accountIndex, 'B').then(() => {
                    const submitTime = Date.now() - actualSubmitStart;
                    console.log(`✅ [${new Date().toLocaleTimeString()}] [${batchId}] Proof B submit completed for account ${accountIndex + 1} (${submitTime}ms)`);
                    resolve({ accountIndex, proofType: 'B', success: true, submitTime });
                }).catch((error) => {
                    const submitTime = Date.now() - actualSubmitStart;
                    const errorMessage = error?.message || JSON.stringify(error) || error.toString();
                    console.log(`❌ [${new Date().toLocaleTimeString()}] [${batchId}] Proof B submit failed for account ${accountIndex + 1}: ${errorMessage}`);
                    resolve({ accountIndex, proofType: 'B', success: false, error: errorMessage, submitTime });
                });
            });
            
            // 延迟13秒提交第三个proof  
            const submitStart3 = Date.now();
            console.log(`📤 [${new Date().toLocaleTimeString()}] [${batchId}] Proof C submission scheduled for account ${accountIndex + 1} (+13s delay)`);
            
            const submitPromise3 = new Promise(async (resolve) => {
                await new Promise(delay => setTimeout(delay, 13000)); // 13秒延迟
                const actualSubmitStart = Date.now();
                console.log(`📤 [${new Date().toLocaleTimeString()}] [${batchId}] Proof C submission initiated for account ${accountIndex + 1} (delayed)`);
                
                this.submitProof(proof3Result.proof, proof3Result.publicInputs, inputSummary3, accountAddress, accountIndex, 'C').then(() => {
                    const submitTime = Date.now() - actualSubmitStart;
                    console.log(`✅ [${new Date().toLocaleTimeString()}] [${batchId}] Proof C submit completed for account ${accountIndex + 1} (${submitTime}ms)`);
                    resolve({ accountIndex, proofType: 'C', success: true, submitTime });
                }).catch((error) => {
                    const submitTime = Date.now() - actualSubmitStart;
                    const errorMessage = error?.message || JSON.stringify(error) || error.toString();
                    console.log(`❌ [${new Date().toLocaleTimeString()}] [${batchId}] Proof C submit failed for account ${accountIndex + 1}: ${errorMessage}`);
                    resolve({ accountIndex, proofType: 'C', success: false, error: errorMessage, submitTime });
                });
            });
            
            const proofGenerationTime = Date.now() - startTime;
            console.log(`🚀 [${new Date().toLocaleTimeString()}] [${batchId}] Triple proof generation completed for account ${accountIndex + 1} (${proofGenerationTime}ms)`);
            console.log(`⏱️ [${batchId}] Timing - Witness: ${witnessTime}ms, Proof: ${proofTime}ms, Total: ${proofGenerationTime}ms`);
            console.log(`📋 [${batchId}] Submit schedule: Proof A (immediate), Proof B (+7s), Proof C (+13s)`);
            
            // 返回三个submit promises
            return { submitPromises: [submitPromise1, submitPromise2, submitPromise3], accountIndex };
            
        } catch (error) {
            this.stats.accountStats[accountAddress].failed += 3;
            let errorMessage;
            
            try {
                errorMessage = error?.message || JSON.stringify(error) || error.toString();
            } catch (stringifyError) {
                errorMessage = 'Unknown error occurred';
            }
            
            console.error(`❌ Triple SHA256 proof cycle failed for account ${accountIndex + 1}: ${errorMessage}\n`);
            throw error;
        }
    }
    
    async runParallelProofCycles() {
        const cycleStartTime = Date.now();
        console.log(`\n🚀 [${new Date().toLocaleTimeString()}] Starting full parallel proof generation across ${this.derivedAccounts.length} accounts...`);
        
        // Promise池管理 - 收集所有submit promises
        const submitPromises = [];
        
        // 所有账户同时开始，不分batch
        console.log(`📊 [${new Date().toLocaleTimeString()}] All ${this.derivedAccounts.length} accounts starting simultaneously`);
        
        const allProofPromises = this.derivedAccounts.map(async (accountAddress, index) => {
            try {
                if (index === 0) {
                    // Account 1 uses triple proof strategy
                    const { submitPromises: tripleSubmitPromises, accountIndex } = await this.runTripleProofCycleAsync(index, `Account1-Triple`);
                    // 添加三个submit promises到监控池
                    tripleSubmitPromises.forEach((promise, proofIndex) => {
                        const proofTypes = ['A', 'B', 'C'];
                        submitPromises.push({ 
                            accountIndex, 
                            promise, 
                            proofType: proofTypes[proofIndex] 
                        });
                    });
                } else {
                    // Other accounts use single proof strategy
                    const accountAddress = this.derivedAccounts[index];
                    this.stats.accountStats[accountAddress].submitted++;
                    
                    const submitPromise = await this.runSingleProofCycleAsync(index, `Account${index+1}-Single`);
                    submitPromises.push({ 
                        accountIndex: index, 
                        promise: submitPromise, 
                        proofType: 'Single' 
                    });
                }
                // Note: 成功统计在monitorAsyncSubmissions中处理
            } catch (error) {
                if (index === 0) {
                    this.stats.failed += 3; // 三个proof都失败
                } else {
                    this.stats.failed += 1; // 一个proof失败
                }
                // Error already logged in respective cycle methods
            }
        });
        
        // Wait for all proof generation to complete (不等待submit)
        console.log(`⚡ [${new Date().toLocaleTimeString()}] Waiting for all ${this.derivedAccounts.length} proof generations to complete...`);
        await Promise.all(allProofPromises);
        
        const proofGenerationEndTime = Date.now();
        const proofGenerationTime = proofGenerationEndTime - cycleStartTime;
        
        console.log(`🎯 [${new Date().toLocaleTimeString()}] All proof generation completed in ${(proofGenerationTime/1000).toFixed(1)}s`);
        console.log(`📋 Monitoring ${submitPromises.length} async submissions...`);
        
        // 异步监控submit结果 (不阻塞下一个cycle)
        this.monitorAsyncSubmissions(submitPromises, cycleStartTime);
        
        const cycleEndTime = Date.now();
        const totalCycleTime = cycleEndTime - cycleStartTime;
        
        // Calculate total attempts: Account 1 = 3 proofs, others = 1 proof each
        const totalAttemptsThisCycle = 3 + (this.derivedAccounts.length - 1);
        this.stats.totalAttempts += totalAttemptsThisCycle;
        
        // Print summary statistics with timing (proof generation only)
        console.log(`\n📊 [${new Date().toLocaleTimeString()}] Mixed parallel cycle completed (proof generation):`);
        console.log(`   Account 1 (triple): 3 proofs, Accounts 2-${this.derivedAccounts.length} (single): ${this.derivedAccounts.length - 1} proofs`);
        console.log(`   Total attempts this cycle: ${totalAttemptsThisCycle}`);
        console.log(`   Proof generation time: ${(proofGenerationTime/1000).toFixed(1)}s`);
        console.log(`   Submit monitoring: ${submitPromises.length} async submissions in progress`);
        console.log(`   ⚡ Mixed strategy: Account 1 triple proof + ${this.derivedAccounts.length - 1} single proof accounts`);
        
        // Update health server statistics
        this.healthServer.updateProofStats(this.stats.totalAttempts, this.stats.successful, this.stats.failed);
    }
    
    async reconnectSessionWithDerivedAccounts() {
        try {
            console.log('🔄 Reconnecting session and restoring derived accounts...');
            
            // Reconnect base session
            this.session = await zkVerifySession.start().Volta().withAccount(this.accountSeed);
            
            // Get base account address
            const accountInfo = await this.session.getAccountInfo();
            const baseAddress = accountInfo[0].address;
            
            // Re-derive all accounts
            console.log(`🔄 Re-deriving ${this.accountCount - 1} accounts...`);
            const derivedAddresses = await this.session.addDerivedAccounts(baseAddress, this.accountCount - 1);
            
            // Update the derived accounts array
            this.derivedAccounts = [baseAddress, ...derivedAddresses];
            
            // Setup event listeners
            this.setupEventListeners();
            
            console.log(`✅ Session reconnected with ${this.derivedAccounts.length} accounts`);
            this.derivedAccounts.forEach((address, index) => {
                console.log(`   Account ${index + 1}: ${address}`);
            });
            
        } catch (error) {
            console.error('❌ Failed to reconnect session with derived accounts:', error.message);
            throw error;
        }
    }
    
    async monitorAsyncSubmissions(submitPromises, cycleStartTime) {
        // 在后台监控所有submit结果，不阻塞主流程
        console.log(`🔍 [${new Date().toLocaleTimeString()}] Starting background monitoring of ${submitPromises.length} submissions...`);
        
        try {
            const submitResults = await Promise.allSettled(submitPromises.map(item => item.promise));
            const monitorEndTime = Date.now();
            const totalSubmitTime = monitorEndTime - cycleStartTime;
            
            // 统计submit结果
            let successfulSubmits = 0;
            let failedSubmits = 0;
            const submitTimes = [];
            
            submitResults.forEach((result, index) => {
                const accountIndex = submitPromises[index].accountIndex;
                const accountAddress = this.derivedAccounts[accountIndex];
                
                if (result.status === 'fulfilled' && result.value.success) {
                    successfulSubmits++;
                    submitTimes.push(result.value.submitTime);
                    // 更新账户级别的成功统计
                    if (this.stats.accountStats[accountAddress]) {
                        this.stats.accountStats[accountAddress].successful++;
                    }
                } else {
                    failedSubmits++;
                    console.log(`❌ Background submit failed for account ${accountIndex + 1}:`, result.reason || result.value?.error);
                    // 更新账户级别的失败统计
                    if (this.stats.accountStats[accountAddress]) {
                        this.stats.accountStats[accountAddress].failed++;
                    }
                }
            });
            
            // 打印详细的submit统计
            const avgSubmitTime = submitTimes.length > 0 ? submitTimes.reduce((a, b) => a + b, 0) / submitTimes.length : 0;
            const maxSubmitTime = submitTimes.length > 0 ? Math.max(...submitTimes) : 0;
            const minSubmitTime = submitTimes.length > 0 ? Math.min(...submitTimes) : 0;
            
            console.log(`\n📈 [${new Date().toLocaleTimeString()}] Async Submit Results:`);
            console.log(`   ✅ Successful submissions: ${successfulSubmits}/${submitPromises.length}`);
            console.log(`   ❌ Failed submissions: ${failedSubmits}/${submitPromises.length}`);
            console.log(`   ⏱️ Submit timing - Avg: ${avgSubmitTime.toFixed(0)}ms, Min: ${minSubmitTime}ms, Max: ${maxSubmitTime}ms`);
            console.log(`   🎯 Total cycle time (including submits): ${(totalSubmitTime/1000).toFixed(1)}s`);
            
            // 更新全局统计
            this.stats.successful += successfulSubmits;
            this.stats.failed += failedSubmits;
            
            // 打印最终账户统计
            console.log(`\n📈 Final Account Statistics:`);
            this.derivedAccounts.forEach((address, index) => {
                const stats = this.stats.accountStats[address];
                if (stats) {
                    const successful = stats.successful || 0;
                    const submitted = stats.submitted || 0;
                    const successRate = submitted > 0 ? ((successful / submitted) * 100).toFixed(1) : 0;
                    console.log(`   Account ${index + 1} (${address.slice(0, 8)}...): ${successful}/${submitted} successful (${successRate}%)`);
                } else {
                    console.log(`   Account ${index + 1} (${address.slice(0, 8)}...): No stats available`);
                }
            });
            
        } catch (error) {
            console.error(`❌ Error monitoring async submissions:`, error.message);
        }
    }
    
    async runContinuous(intervalSeconds = 30) {
        console.log(`🔄 Starting continuous mixed SHA256 proof submission every ${intervalSeconds} seconds...`);
        console.log(`🧮 Circuit: SHA256 (k≈20, 1,031,716 constraints, 16384-bit input)`);
        console.log(`👥 Mixed strategy: Account 1 (triple proof), Accounts 2-${this.derivedAccounts.length} (single proof)`);
        
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