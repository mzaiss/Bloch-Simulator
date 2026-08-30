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
    var epi = Pulseq.parse(readSeq("web5_EPI_16.seq"));
    var sum = epi.summary();
    assert.ok(rare.nRf > 1 && rare.duration > 0);
    assert.ok(sum.nRf >= 1 && sum.duration > 0);
    var wf = epi.rasterize(50e-6);
    var maxGx = 0, maxGy = 0;
    for (var i = 0; i < wf.n; i++) {
        maxGx = Math.max(maxGx, Math.abs(wf.gx[i]));
        maxGy = Math.max(maxGy, Math.abs(wf.gy[i]));
    }
    assert.ok(maxGx > 3000, "EPI Gx peak " + maxGx);
    assert.ok(maxGy > 500, "EPI Gy peak " + maxGy);
    console.log("ok RARE", rare);
    console.log("ok EPI", sum, "maxGx", maxGx);
})();

// Playback integrates each frame instead of point-sampling it. These check the two
// properties that fixes: the result must not depend on frame rate or playback speed.

/** Rodrigues rotation, matching BlochStep's applyAxisAngle(axis, -|B|*dt*gamma). */
function rotate(M, axis, angle) {
    var c = Math.cos(angle);
    var s = Math.sin(angle);
    var dot = axis[0] * M[0] + axis[1] * M[1] + axis[2] * M[2];
    var cross = [
        axis[1] * M[2] - axis[2] * M[1],
        axis[2] * M[0] - axis[0] * M[2],
        axis[0] * M[1] - axis[1] * M[0]
    ];
    for (var i = 0; i < 3; i++) M[i] = M[i] * c + cross[i] * s + axis[i] * dot * (1 - c);
}

/**
 * Replays a sequence the way the browser does: integrate the waveform over each frame,
 * sub-step while RF is on, and rotate M. Returns the resulting tip angle and the net
 * gradient winding, both of which must be independent of fps and playback stretch.
 */
function replay(wf, fps, stretch, gradScale) {
    var M = [0, 0, 1];
    var dtWall = 1 / fps;
    var kx = 0;
    var wind = 0;
    var t = 0;
    while (t < wf.duration) {
        var t1 = Math.min(t + dtWall / stretch, wf.duration);
        var wall = (t1 - t) * stretch;
        var frame = Pulseq.meanOver(wf, t, t1);
        var frameAmp = Math.sqrt(frame.rfRe * frame.rfRe + frame.rfIm * frame.rfIm);
        var nSteps = Math.max(1, Math.min(128,
            Math.ceil(Pulseq.rfToEdu(frameAmp, stretch) * wall / 0.05)));
        for (var i = 0; i < nSteps; i++) {
            var a = t + (t1 - t) * i / nSteps;
            var b = t + (t1 - t) * (i + 1) / nSteps;
            var m = Pulseq.meanOver(wf, a, b);
            var amp = Math.sqrt(m.rfRe * m.rfRe + m.rfIm * m.rfIm);
            if (amp > 0) {
                var phase = Math.atan2(m.rfIm, m.rfRe);
                var angle = Pulseq.rfToEdu(amp, stretch) * wall / nSteps;
                rotate(M, [Math.cos(phase), -Math.sin(phase), 0], -angle);
                wind += angle * 180 / Math.PI;
            }
        }
        kx += Pulseq.gradToEdu(frame.gx, stretch, gradScale) * wall;
        t = t1;
    }
    return {
        flip: Math.acos(Math.max(-1, Math.min(1, M[2]))) * 180 / Math.PI,
        wind: wind,
        kx: kx
    };
}

(function testMeanOverMatchesAnalyticTrapezoid() {
    var seq = Pulseq.parse(readSeq("web5_EPI_16.seq"));
    var wf = seq.rasterize(20e-6);
    var m = Pulseq.meanOver(wf, 0, wf.duration);
    var manual = 0;
    for (var i = 1; i < wf.n; i++) manual += 0.5 * (wf.gx[i - 1] + wf.gx[i]) * wf.dt;
    almost(m.gx * wf.duration, manual, Math.abs(manual) * 1e-6 + 1e-9, "integrated Gx");

    var split = 0;
    var edges = 37;
    for (var k = 0; k < edges; k++) {
        var a = wf.duration * k / edges;
        var b = wf.duration * (k + 1) / edges;
        split += Pulseq.meanOver(wf, a, b).gx * (b - a);
    }
    almost(split, m.gx * wf.duration, Math.abs(manual) * 1e-6 + 1e-9, "sub-interval means");
})();

(function testFrameRateAndSpeedIndependence() {
    var seq = Pulseq.parse(readSeq("web5_EPI_16.seq"));
    var wf = seq.rasterize(20e-6);
    var gradScale = 11;
    var stretch = 8 / wf.duration;

    var base = replay(wf, 60, stretch, gradScale);
    var lowFps = replay(wf, 12, stretch, gradScale);
    almost(lowFps.flip, base.flip, 1, "EPI flip must not depend on frame rate");
    almost(lowFps.kx, base.kx, Math.abs(base.kx) * 0.01 + 1e-6,
        "gradient winding must not depend on frame rate");

    // The speed slider spans 0.05x to 5x, a 100x range of stretch.
    var quick = replay(wf, 60, stretch / 5, gradScale);
    var crawl = replay(wf, 60, stretch / 0.05, gradScale);
    almost(quick.flip, base.flip, 2, "flip must not depend on playback speed");
    almost(crawl.flip, base.flip, 1, "flip must not depend on playback speed");
    almost(quick.kx, base.kx, Math.abs(base.kx) * 0.02 + 1e-6,
        "gradient winding must not depend on playback speed");
    almost(crawl.kx, base.kx, Math.abs(base.kx) * 0.01 + 1e-6,
        "gradient winding must not depend on playback speed");
    almost(base.flip, 90, 1, "EPI excitation is a 90 deg sinc");

    // A readout lobe should wind roughly one turn across the Plane edge (4 scene units).
    var lobe = Pulseq.gradToEdu(4000, stretch, gradScale) * 4 / gradScale * (0.0045 * stretch);
    assert.ok(lobe > 3 && lobe < 12, "EPI readout winding at plane edge: " + lobe.toFixed(2) + " rad");
    console.log("ok integration: EPI flip", base.flip.toFixed(1), "deg at 60fps,",
        lowFps.flip.toFixed(1), "at 12fps,", quick.flip.toFixed(1), "at 5x speed; readout winding",
        lobe.toFixed(2), "rad");
})();

(function testIntegrationBeatsPointSampling() {
    // The reported bug: one sample per frame only survives at very low playback speed,
    // because a fast playback covers a whole 1 ms pulse within a frame or two.
    var seq = Pulseq.parse(readSeq("web1_FID.seq"));
    var wf = seq.rasterize(5e-6);
    var nominal = 30 + 60 + 90 + 120 + 150 + 180 + 210 + 240 + 270 + 300 + 330 + 360;
    var baseStretch = 8 / wf.duration;

    function pointSampled(stretch) {
        var dtWall = 1 / 60;
        var sum = 0;
        for (var t = 0; t < wf.duration; t += dtWall / stretch) {
            var i = Math.min(wf.n - 1, Math.round(t / wf.dt));
            sum += Pulseq.rfToEdu(wf.rfAmp[i], stretch) * dtWall * 180 / Math.PI;
        }
        return sum;
    }

    var speeds = [0.05, 1, 5];
    for (var s = 0; s < speeds.length; s++) {
        var integrated = replay(wf, 60, baseStretch / speeds[s], 11).wind;
        almost(integrated, nominal, nominal * 0.03,
            "integrated FID flips at " + speeds[s] + "x");
    }
    assert.ok(Math.abs(pointSampled(baseStretch / 5) - nominal) > nominal * 0.15,
        "point sampling at 5x should be far off, summed " + pointSampled(baseStretch / 5).toFixed(0));
    console.log("ok FID integrated within 3% at 0.05x/1x/5x; point sampling at 5x gives",
        pointSampled(baseStretch / 5).toFixed(0), "deg vs nominal", nominal);
})();

(function testShapeDecompressBlockPulse() {
    var samples = Pulseq.decompressShape([1, 0, 0, 997, -1, 0, 0, 17], 1020);
    assert.strictEqual(samples.length, 1020);
    var ones = 0;
    for (var i = 0; i < samples.length; i++) if (Math.abs(samples[i] - 1) < 1e-9) ones++;
    assert.ok(ones >= 990 && ones <= 1010, "block pulse ones=" + ones);
})();

console.log("All pulseq tests passed.");
