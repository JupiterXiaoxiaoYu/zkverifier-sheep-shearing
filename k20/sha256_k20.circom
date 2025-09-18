pragma circom 2.0.0;

include "../circomlib/circuits/sha256/sha256.circom";
include "../circomlib/circuits/bitify.circom";

template LargeSha256K20() {
    signal input in[16384];  // 16384-bit input for k≈20 (target ~1M constraints)
    signal output out[4];    // 4 public outputs - pack 256 bits into 4 field elements (64 bits each)
    
    component sha256 = Sha256(16384);
    for (var i = 0; i < 16384; i++) {
        sha256.in[i] <== in[i];
    }
    
    // Pack bits into field elements (64 bits per element)
    component bits2num[4];
    for (var i = 0; i < 4; i++) {
        bits2num[i] = Bits2Num(64);
        for (var j = 0; j < 64; j++) {
            bits2num[i].in[j] <== sha256.out[i*64 + j];
        }
        out[i] <== bits2num[i].out;
    }
}

component main = LargeSha256K20();