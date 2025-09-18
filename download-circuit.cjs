const fs = require('fs');
const https = require('https');
const path = require('path');

class CircuitDownloader {
    constructor() {
        this.baseUrl = 'https://github.com/JupiterXiaoxiaoYu/zkverify-sheep-shearing/releases/download/v1.0.0';
        this.files = [
            {
                name: 'sha256_k20_0000.zkey',
                path: './k20/sha256_k20_0000.zkey',
                size: 541519920,
                url: `${this.baseUrl}/sha256_k20_0000.zkey`
            }
        ];
    }

    async downloadFile(file) {
        console.log(`⚠️ Circuit file ${file.name} is missing or corrupted`);
        console.log('❌ Cannot download replacement - Git LFS file not properly synced');
        console.log('🔧 Please ensure Git LFS files are properly configured in Railway');
        throw new Error(`Missing circuit file: ${file.name}. This is likely a Git LFS sync issue.`);
    }

    async downloadAll() {
        console.log('🚀 Starting circuit file download...');
        
        for (const file of this.files) {
            try {
                await this.downloadFile(file);
            } catch (error) {
                console.error(`❌ Failed to download ${file.name}:`, error.message);
                throw error;
            }
        }
        
        console.log('✅ All circuit files downloaded successfully');
    }

    async verify() {
        console.log('🔍 Verifying circuit files...');
        
        for (const file of this.files) {
            if (!fs.existsSync(file.path)) {
                throw new Error(`Missing file: ${file.path}`);
            }
            
            const stats = fs.statSync(file.path);
            if (stats.size !== file.size) {
                throw new Error(`Incorrect file size for ${file.path}: ${stats.size} vs expected ${file.size}`);
            }
            
            console.log(`✅ ${file.name}: ${stats.size} bytes`);
        }
        
        console.log('✅ All circuit files verified');
    }
}

// Export for use in main script
module.exports = CircuitDownloader;

// Run if called directly
if (require.main === module) {
    async function main() {
        const downloader = new CircuitDownloader();
        try {
            await downloader.downloadAll();
            await downloader.verify();
        } catch (error) {
            console.error('❌ Download failed:', error.message);
            process.exit(1);
        }
    }
    
    main();
}