# Automated ZK Proof Generation and Submission

This system automatically generates Groth16 zero-knowledge proofs using a test circuit and submits them to zkVerify continuously.

## Features

- **Automated Proof Generation**: Generates random valid inputs and creates Groth16 proofs
- **Continuous Submission**: Submits proofs to zkVerify at configurable intervals  
- **Event Monitoring**: Tracks proof inclusion and aggregation events
- **Data Persistence**: Saves proof data, submissions, and aggregation receipts

## Setup

1. **Environment Configuration**
   Create a `.env` file with your seed phrase:
   ```
   SEED_PHRASE="your twelve word seed phrase here"
   ```

2. **Get Testnet Tokens**
   Obtain $tVFY tokens from:
   - [Community Faucet](https://www.faucy.com/zkverify-volta)
   - [zkVerify Discord](https://discord.gg/zkverify)

3. **Install Dependencies**
   ```bash
   npm install
   ```

## Usage

### Quick Start (Recommended)
```bash
# Run continuous automated proof generation and submission (30 second intervals)
npm run automated-continuous

# Run faster automated submission (10 second intervals)  
npm run automated-fast

# Submit a single proof
npm run automated-single
```

### Individual Components

**Generate Proofs Only:**
```bash
# Generate a single proof
npm run generate-proof

# Generate proofs continuously every 10 seconds
npm run generate-continuous
```

**Submit Existing Proof:**
```bash
# Submit proof from ./data/ directory
npm run submit-proof
```

### Advanced Usage

**Custom Intervals:**
```bash
# Custom interval (in seconds)
node automated-pipeline-fixed.cjs --continuous --interval 60

# Test with shorter intervals
node automated-pipeline-fixed.cjs --continuous --interval 15
```

## Circuit Details

The system uses a test circuit (`circuit.circom`) which:
- Takes three inputs: `a`, `b`, and `c` (all positive integers)
- Performs complex multiplication and iteration operations
- Outputs a single public signal `d`
- Has 4 public signals total (including the inputs)

## Generated Files

The system creates several files in the `./data/` directory:

- `proof.json` - Latest generated proof
- `public.json` - Latest public signals (4 values: output + 3 inputs)
- `main.groth16.vkey.json` - Verification key (matches test circuit)
- `submission_N.json` - Details of each proof submission
- `aggregation_N.json` - Aggregation receipt data

## Output Example

```
🚀 Initializing automated proof pipeline...
✅ Pipeline initialized successfully
🔄 Starting continuous proof submission every 15 seconds...

🔢 Submitting proof #1...
Generating new proof using test circuit...
Inputs: a=64, b=27, c=91
✅ Proof generated successfully!
Public signals: [9487945389740368250700446844574763290626989940674248221085446829475875250720, 64, 27, 91]
✅ Proof #2 included in block: {
  statement: '0xb3301edf1aea4b03890534cfea845261327f13ad53384d157ce2125134da4be8',
  aggregationId: 96207,
  inputs: { a: '64', b: '27', c: '91' }
}

🔢 Submitting proof #2...
Generating new proof using test circuit...
Inputs: a=13, b=91, c=75
✅ Proof generated successfully!
Public signals: [16680526167012709189659440617026621887066564364559834618966561753397231602146, 13, 91, 75]
✅ Proof #3 included in block: {...}

📧 New aggregation receipt received: {
  domainId: '0',
  aggregationId: '96,207',
  blockHash: '0x571774334687c750d467049e67a5815561ee44cba23fcbc6b6fff4c76f35059c'
}
💾 Aggregation data saved for ID: 96207
```

## Troubleshooting

1. **"Inability to pay some fees"** - Get testnet tokens from the faucet
2. **"Invalid verification key"** - Verification key has been updated to match the test circuit
3. **"Invalid seed phrase"** - Check your `.env` file configuration and use a valid 12-word mnemonic

## Architecture

- `automated-pipeline-fixed.cjs` - Main automated pipeline (CommonJS format to resolve import issues)
- `simple-proof-generator.js` - Pure proof generation logic (ES modules)
- `index.js` - Original manual proof submission script

## Key Features

### Test Circuit Integration
The system uses the built-in `circom_runtime` test circuit:
- **WASM Path**: `./node_modules/circom_runtime/test/circuit/circuit_js/circuit.wasm`
- **ZKEY Path**: `./node_modules/circom_runtime/test/circuit/circuit.zkey`
- **Verification Key**: Automatically loaded from the test circuit

### Event Monitoring
- Listens for `IncludedInBlock` events when proofs are accepted
- Monitors `NewAggregationReceipt` events for proof aggregation
- Saves detailed submission and aggregation data

### Error Handling
- Continues running even if individual proof submissions fail
- Graceful shutdown with Ctrl+C
- Comprehensive error logging

The automated pipeline is the recommended way to use this system as it handles the complete workflow from proof generation to submission and monitoring using working test circuits.# zkverifier-sheep-shearing
