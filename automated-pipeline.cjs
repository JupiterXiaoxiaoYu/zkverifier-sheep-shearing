const { zkVerifySession, Library, CurveType, ZkVerifyEvents } = require("zkverifyjs");
const dotenv = require('dotenv');
const fs = require("fs");

dotenv.config();

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message || error);
    console.log('🔄 Process will continue...');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Promise Rejection:', reason?.message || reason);
    console.log('🔄 Process will continue...');
});

// Import simple-proof-generator functionality
const snarkjs = require('snarkjs');

// Use local circuit files from circom_runtime test
const WASM_PATH = './node_modules/circom_runtime/test/circuit/circuit_js/circuit.wasm';
const ZKEY_PATH = './node_modules/circom_runtime/test/circuit/circuit.zkey';

// Verification key for the test circuit (from verification_key.json)
const VKEY_DATA = {
  "protocol": "groth16",
  "curve": "bn128",
  "nPublic": 4,
  "vk_alpha_1": [
    "20491192805390485299153009773594534940189261866228447918068658471970481763042",
    "9383485363053290200918347156157836566562967994039712273449902621266178545958",
    "1"
  ],
  "vk_beta_2": [
    [
      "6375614351688725206403948262868962793625744043794305715222011528459656738731",
      "4252822878758300859123897981450591353533073413197771768651442665752259397132"
    ],
    [
      "10505242626370262277552901082094356697409835680220590971873171140371331206856",
      "21847035105528745403288232691147584728191162732299865338377159692350059136679"
    ],
    [
      "1",
      "0"
    ]
  ],
  "vk_gamma_2": [
    [
      "10857046999023057135944570762232829481370756359578518086990519993285655852781",
      "11559732032986387107991004021392285783925812861821192530917403151452391805634"
    ],
    [
      "8495653923123431417604973247489272438418190587263600148770280649306958101930",
      "4082367875863433681332203403145435568316851327593401208105741076214120093531"
    ],
    [
      "1",
      "0"
    ]
  ],
  "vk_delta_2": [
    [
      "3975790311893893341340161766879905936958661067882264032474266902345378689989",
      "644478862152636240062151223979355724911820071041473015124265160845680677640"
    ],
    [
      "18653336180275048042902643932736430752334488465561901574241586300721370515350",
      "4439809646982105720900774322696795865391078961997895171991532846160287677573"
    ],
    [
      "1",
      "0"
    ]
  ],
  "vk_alphabeta_12": [
    [
      [
        "2029413683389138792403550203267699914886160938906632433982220835551125967885",
        "21072700047562757817161031222997517981543347628379360635925549008442030252106"
      ],
      [
        "5940354580057074848093997050200682056184807770593307860589430076672439820312",
        "12156638873931618554171829126792193045421052652279363021382169897324752428276"
      ],
      [
        "7898200236362823042373859371574133993780991612861777490112507062703164551277",
        "7074218545237549455313236346927434013100842096812539264420499035217050630853"
      ]
    ],
    [
      [
        "7077479683546002997211712695946002074877511277312570035766170199895071832130",
        "10093483419865920389913245021038182291233451549023025229112148274109565435465"
      ],
      [
        "4595479056700221319381530156280926371456704509942304414423590385166031118820",
        "19831328484489333784475432780421641293929726139240675179672856274388269393268"
      ],
      [
        "11934129596455521040620786944827826205713621633706285934057045369193958244500",
        "8037395052364110730298837004334506829870972346962140206007064471173334027475"
      ]
    ]
  ],
  "IC": [
    [
      "13301910515319440036781559521244314286896559228088406220286498587163275032898",
      "21752102455923956970297538199953311940955308225446086282237557428140916857247",
      "1"
    ],
    [
      "17482596306642470706171849523416052476936601967698452358356767181693176975875",
      "16875289648181723199466955981261105815550134487513330320459939834929279218791",
      "1"
    ],
    [
      "5772884469279940971460880086361780610840620334751263386570253375423022114824",
      "19701704231049813163687130014634352753198605671093169759803278572696433587644",
      "1"
    ],
    [
      "20438355410214480154024250925177562386037016834261610289216986319964190521404",
      "15984525382738813974840145618800038332013248407344020798478497142205284007916",
      "1"
    ],
    [
      "1311730469912073488579103303436905662163459373538656417086366898821493109364",
      "11969131862858876373690771619700437495976850333829176058509962039594565501218",
      "1"
    ]
  ]
};

// Create data directory if it doesn't exist
if (!fs.existsSync('./data')) {
    fs.mkdirSync('./data');
}

// Function to generate random valid inputs for the test circuit
function generateRandomInputs() {
    // The test circuit expects three inputs: a, b, c
    const a = Math.floor(Math.random() * 100) + 1;
    const b = Math.floor(Math.random() * 100) + 1;
    const c = Math.floor(Math.random() * 100) + 1;
    return { 
        "a": a.toString(), 
        "b": b.toString(), 
        "c": c.toString() 
    };
}

// Function to generate a proof
async function generateProof() {
    try {
        console.log('Generating new proof using test circuit...');
        
        // Check if circuit files exist
        if (!fs.existsSync(WASM_PATH)) {
            throw new Error(`WASM file not found at ${WASM_PATH}`);
        }
        if (!fs.existsSync(ZKEY_PATH)) {
            throw new Error(`ZKEY file not found at ${ZKEY_PATH}`);
        }
        
        // Generate random inputs
        const inputs = generateRandomInputs();
        console.log(`Inputs: a=${inputs.a}, b=${inputs.b}, c=${inputs.c}`);
        
        // Generate proof using snarkjs with file paths
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            inputs,
            WASM_PATH,
            ZKEY_PATH
        );
        
        // Save proof data
        fs.writeFileSync('./data/proof.json', JSON.stringify(proof, null, 2));
        fs.writeFileSync('./data/public.json', JSON.stringify(publicSignals, null, 2));
        fs.writeFileSync('./data/main.groth16.vkey.json', JSON.stringify(VKEY_DATA, null, 2));
        
        console.log('✅ Proof generated successfully!');
        console.log(`Public signals: [${publicSignals.join(', ')}]`);
        
        return { proof, publicSignals, inputs };
        
    } catch (error) {
        console.error('❌ Error generating proof:', error.message);
        throw error;
    }
}

class AutomatedProofPipeline {
    constructor() {
        this.session = null;
        this.isRunning = false;
        this.proofCount = 0;
    }

    async initialize() {
        console.log('🚀 Initializing automated proof pipeline...');
        
        // Initialize zkVerify session
        this.session = await zkVerifySession.start().Volta().withAccount(process.env.SEED_PHRASE);
        
        // Set up event listeners
        this.setupEventListeners();
        
        console.log('✅ Pipeline initialized successfully');
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

    async submitProof() {
        const maxRetries = 3;
        let retryCount = 0;
        
        while (retryCount < maxRetries) {
            try {
                console.log(`\n🔢 Submitting proof #${this.proofCount + 1}...${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);
                
                // Generate new proof
                const { proof, publicSignals, inputs } = await generateProof();
                
                // Read the saved proof files
                const proofData = JSON.parse(fs.readFileSync("./data/proof.json"));
                const publicInputs = JSON.parse(fs.readFileSync("./data/public.json"));
                const vkey = JSON.parse(fs.readFileSync("./data/main.groth16.vkey.json"));
                
                // Submit to zkVerify with promise wrapper to catch async errors
                const submissionPromise = new Promise(async (resolve, reject) => {
                    try {
                        const { events } = await this.session.verify()
                            .groth16({library: Library.snarkjs, curve: CurveType.bn128})
                            .execute({
                                proofData: {
                                    vk: vkey,
                                    proof: proofData,
                                    publicSignals: publicInputs
                                }, 
                                domainId: 0
                            });

                        // Handle submission events
                        events.on(ZkVerifyEvents.IncludedInBlock, (eventData) => {
                            console.log(`✅ Proof #${this.proofCount + 1} included in block:`, {
                                statement: eventData.statement,
                                aggregationId: eventData.aggregationId,
                                inputs: inputs
                            });
                            
                            // Save submission details
                            const submissionData = {
                                proofNumber: this.proofCount + 1,
                                inputs: inputs,
                                statement: eventData.statement,
                                aggregationId: eventData.aggregationId,
                                timestamp: new Date().toISOString(),
                                publicSignals: publicInputs
                            };
                            
                            fs.writeFileSync(
                                `./data/submission_${this.proofCount + 1}.json`, 
                                JSON.stringify(submissionData, null, 2)
                            );
                            
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

                this.proofCount++;
                return; // Success, exit retry loop
                
            } catch (error) {
                retryCount++;
                let errorMessage = 'Unknown error';
                if (error && typeof error === 'object') {
                    errorMessage = error.message || JSON.stringify(error) || error.toString();
                } else if (error) {
                    errorMessage = error.toString();
                }
                console.error(`❌ Error submitting proof #${this.proofCount + 1} (attempt ${retryCount}):`, errorMessage);
                
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
                            this.session = await zkVerifySession.start().Volta().withAccount(process.env.SEED_PHRASE);
                            this.setupEventListeners();
                            console.log('✅ Session reconnected successfully');
                        } catch (reconnectError) {
                            console.error('❌ Failed to reconnect session:', reconnectError?.message || reconnectError);
                        }
                    }
                } else {
                    // Either not a retryable error or max retries reached
                    if (retryCount >= maxRetries) {
                        console.error(`❌ Max retries (${maxRetries}) reached for proof #${this.proofCount + 1}`);
                    }
                    // Don't throw error, just log and continue with next proof
                    break;
                }
            }
        }
    }

    async startContinuousSubmission(intervalSeconds = 30) {
        if (this.isRunning) {
            console.log('⚠️ Pipeline is already running');
            return;
        }

        this.isRunning = true;
        console.log(`🔄 Starting continuous proof submission every ${intervalSeconds} seconds...`);
        
        // Submit initial proof
        await this.submitProof();
        
        // Set up interval for continuous submission
        const interval = setInterval(async () => {
            if (!this.isRunning) {
                clearInterval(interval);
                return;
            }
            
            try {
                await this.submitProof();
            } catch (error) {
                const errorMessage = error?.message || error?.toString() || 'Unknown error';
                console.error('❌ Error in continuous submission:', errorMessage);
                console.log('🔄 Continuing with next proof submission...');
                // Don't stop the pipeline on single errors
            }
        }, intervalSeconds * 1000);
        
        // Handle graceful shutdown
        process.on('SIGINT', () => {
            console.log('\n🛑 Gracefully shutting down pipeline...');
            this.isRunning = false;
            clearInterval(interval);
            process.exit(0);
        });
    }

    async submitSingleProof() {
        await this.submitProof();
        console.log('✅ Single proof submission completed');
        // Exit the process after single submission
        process.exit(0);
    }

    stop() {
        this.isRunning = false;
        console.log('🛑 Pipeline stopped');
    }
}

// Command line interface
if (require.main === module) {
    const args = process.argv.slice(2);
    
    async function main() {
        const pipeline = new AutomatedProofPipeline();
        await pipeline.initialize();
        
        if (args.includes('--continuous')) {
            const intervalIndex = args.indexOf('--interval');
            const interval = intervalIndex !== -1 && args[intervalIndex + 1] 
                ? parseInt(args[intervalIndex + 1])
                : 30; // Default 30 seconds
            
            await pipeline.startContinuousSubmission(interval);
        } else {
            // Submit single proof
            await pipeline.submitSingleProof();
        }
    }
    
    main().catch(console.error);
}

module.exports = { AutomatedProofPipeline, generateProof };