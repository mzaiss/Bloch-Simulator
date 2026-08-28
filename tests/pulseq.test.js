"use strict";

var fs = require("fs");
var path = require("path");
var assert = require("assert");
var Pulseq = require("../js/pulseq.js");

var seqDir = path.join(__dirname, "..", "seq");

function readSeq(name) {
    return fs.readFileSync(path.join(seqDir, name), "utf8");
}

function almost(a, b, tol, msg) {
    assert.ok(Math.abs(a - b) <= tol, (msg || "") + " expected " + b + " got " + a);
}

(function testFidParseAndFlips() {
    var seq = Pulseq.parse(readSeq("web1_FID.seq"));
    var sum = seq.summary();
    assert.strictEqual(sum.nRf, 12);
    assert.strictEqual(sum.nAdc, 12);
    assert.ok(sum.duration > 0.04 && sum.duration < 0.08, "FID duration " + sum.duration);
    for (var i = 0; i < 12; i++) {
        almost(sum.flips[i], (i + 1) * 30, 2, "FID flip " + (i + 1));
    }
    var wf = seq.rasterize(20e-6);
    assert.ok(wf.n > 100);
    var peak = 0;
    for (var k = 0; k < wf.n; k++) if (wf.rfAmp[k] > peak) peak = wf.rfAmp[k];
    assert.ok(peak > 900, "last FID RF should reach ~1000 Hz, got " + peak);
    console.log("ok FID", sum);
})();

(function testSpinEcho() {
    var seq = Pulseq.parse(readSeq("web2_SpinEcho_me.seq"));
    var sum = seq.summary();
    assert.strictEqual(sum.nRf, 13);
    almost(sum.flips[0], 90, 2, "SE excitation");
    for (var i = 1; i < sum.flips.length; i++) almost(sum.flips[i], 180, 3, "SE refocus " + i);
    console.log("ok SpinEcho", sum);
})();

(function testFlashHasGradients() {
    var seq = Pulseq.parse(readSeq("web3_FLASH_16.seq"));
    var sum = seq.summary();
    assert.ok(sum.nRf >= 16, "FLASH RF count " + sum.nRf);
    var wf = seq.rasterize(50e-6);
    var maxGx = 0, maxGy = 0;
    for (var i = 0; i < wf.n; i++) {
        maxGx = Math.max(maxGx, Math.abs(wf.gx[i]));
        maxGy = Math.max(maxGy, Math.abs(wf.gy[i]));
    }
    assert.ok(maxGx > 1000, "FLASH Gx peak " + maxGx);
    assert.ok(maxGy > 100, "FLASH Gy peak " + maxGy);
    console.log("ok FLASH", sum, "maxGx", maxGx, "maxGy", maxGy);
})();

(function testRareAndEpi() {
    var rare = Pulseq.parse(readSeq("web4_RARE_16.seq")).summary();
    var epi = Pulseq.parse(readSeq("web5_EPI_16.seq")).summary();
    assert.ok(rare.nRf > 1 && rare.duration > 0);
    assert.ok(epi.nRf >= 1 && epi.duration > 0);
    console.log("ok RARE", rare);
    console.log("ok EPI", epi);
})();

(function testShapeDecompressBlockPulse() {
    var samples = Pulseq.decompressShape([1, 0, 0, 997, -1, 0, 0, 17], 1020);
    assert.strictEqual(samples.length, 1020);
    var ones = 0;
    for (var i = 0; i < samples.length; i++) if (Math.abs(samples[i] - 1) < 1e-9) ones++;
    assert.ok(ones >= 990 && ones <= 1010, "block pulse ones=" + ones);
})();

console.log("All pulseq tests passed.");
