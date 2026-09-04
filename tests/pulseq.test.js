"use strict";

var fs = require("fs");
var path = require("path");
var assert = require("assert");
var Pulseq = require("../js/pulseq.js");

var seqDir = path.join(__dirname, "..", "seq");

function readSeq(name) {
    return fs.readFileSync(path.join(seqDir, name), "utf8");
}

function readFixture(name) {
    return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
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
    for (var k = 0; k < wf.n; k++) peak = Math.max(peak, Math.hypot(wf.rfRe[k], wf.rfIm[k]));
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

    // Across the full span of the speed slider, 0.002x to 20x. The fast end is the hard
    // one: a frame covers 20 ms of sequence there, several times a whole RF pulse.
    var quick = replay(wf, 60, stretch / 20, gradScale);
    var crawl = replay(wf, 60, stretch / 0.002, gradScale);
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
        lowFps.flip.toFixed(1), "at 12fps,", quick.flip.toFixed(1), "at 20x speed; readout winding",
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
            sum += Pulseq.rfToEdu(Math.hypot(wf.rfRe[i], wf.rfIm[i]), stretch) *
                dtWall * 180 / Math.PI;
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

(function testSimultaneousXYGradients() {
    // Gx and Gy are integrated and applied as independent channels, so an oblique
    // gradient works; the simulator sums them as (Gx*x + Gy*y)/gradScale.
    var gradScale = 11;
    ["web3_FLASH_16.seq", "web5_EPI_16.seq"].forEach(function (file) {
        var seq = Pulseq.parse(readSeq(file));
        var wf = seq.rasterize(20e-6);
        var overlapping = 0;
        for (var i = 0; i < wf.n; i++) {
            if (Math.abs(wf.gx[i]) > 1 && Math.abs(wf.gy[i]) > 1) overlapping++;
        }
        assert.ok(overlapping > 20, file + " should drive Gx and Gy together, samples: " + overlapping);

        // A playback frame covering that overlap must carry both channels at once.
        var stretch = 8 / wf.duration;
        var dtWall = 1 / 60;
        var both = null;
        for (var t = 0; t < wf.duration && !both; t += dtWall / stretch) {
            var m = Pulseq.meanOver(wf, t, Math.min(t + dtWall / stretch, wf.duration));
            if (Math.abs(m.gx) > 1 && Math.abs(m.gy) > 1) both = m;
        }
        assert.ok(both, file + ": a frame must integrate Gx and Gy simultaneously");

        // The oblique field tilts the phase ramp away from both axes.
        var gx = Pulseq.gradToEdu(both.gx, stretch, gradScale);
        var gy = Pulseq.gradToEdu(both.gy, stretch, gradScale);
        var angle = Math.atan2(gy, gx) * 180 / Math.PI;
        assert.ok(Math.abs(gx) > 0 && Math.abs(gy) > 0, file + ": both channels must be non-zero");
        console.log("ok simultaneous Gx/Gy in " + file + ": " + overlapping +
            " samples, frame Gx " + gx.toFixed(1) + " Gy " + gy.toFixed(1) +
            " (dephasing " + angle.toFixed(0) + " deg off the x axis)");
    });
})();

(function testSuggestedRasterIsFineButBounded() {
    var fid = Pulseq.parse(readSeq("web1_FID.seq"));
    var dt = fid.suggestedRaster();
    almost(dt, 0.5e-6, 1e-12, "raster should be half the 1 us RF raster");

    var fine = fid.rasterize(dt);
    assert.ok(fine.n > 100000 && fine.n <= 300001, "FID samples at fine raster: " + fine.n);

    // 10x finer than the previous 5 us grid, so pulse edges land closer to the grid and
    // the integrated flip lands closer to nominal.
    var nominal = 30 + 60 + 90 + 120 + 150 + 180 + 210 + 240 + 270 + 300 + 330 + 360;
    var stretch = 8 / fine.duration;
    var coarseErr = Math.abs(replay(fid.rasterize(5e-6), 60, stretch, 11).wind - nominal);
    var fineErr = Math.abs(replay(fine, 60, stretch, 11).wind - nominal);
    assert.ok(fineErr < coarseErr, "fine raster error " + fineErr.toFixed(1) +
        " should beat coarse " + coarseErr.toFixed(1));
    assert.ok(fineErr < nominal * 0.005, "fine raster within 0.5%: " + fineErr.toFixed(1) + " deg");

    // A long sequence must fall back to a coarser raster rather than eat memory.
    var long = Pulseq.parse([
        "[VERSION]", "major 1", "minor 2", "revision 0",
        "[BLOCKS]", "1 1 0 0 0 0 0",
        "[DELAYS]", "1 2000000"
    ].join("\n"));
    almost(long.summary().duration, 2, 1e-9, "synthetic 2 s sequence");
    var longWf = long.rasterize(long.suggestedRaster());
    assert.ok(longWf.n <= 300001, "long sequence capped at " + longWf.n + " samples");
    console.log("ok raster: FID dt", (dt * 1e9).toFixed(0), "ns ->", fine.n,
        "samples, flip error", fineErr.toFixed(1), "deg (was", coarseErr.toFixed(1) +
        "); 2 s sequence capped at", longWf.n);
})();

(function testExtendedTrapezoidTimeShape() {
    // From v1.4 a gradient may carry a time_id: the samples sit at the times in that
    // shape rather than on the uniform gradient raster. Ramp 0->1000 Hz/m over 20 us,
    // flat to 80 us, back to 0 at 100 us.
    var seq = Pulseq.parse([
        "[VERSION]", "major 1", "minor 4", "revision 0",
        "[DEFINITIONS]",
        "GradientRasterTime 1e-05",
        "RadiofrequencyRasterTime 1e-06",
        "BlockDurationRaster 1e-05",
        "# id duration rf gx gy gz adc ext",
        "[BLOCKS]", "1 10 0 1 0 0 0 0",
        "# id amplitude shape_id time_id delay",
        "[GRADIENTS]", "1 1000 1 2 0",
        // Shapes holding exactly num_samples entries are stored raw: amplitudes 0..1,
        // and sample times in gradient-raster units.
        "[SHAPES]",
        "shape_id 1", "num_samples 4", "0", "1", "1", "0",
        "shape_id 2", "num_samples 4", "0", "2", "8", "10"
    ].join("\n"));

    almost(seq.summary().duration, 100e-6, 1e-12, "block duration from the v1.4 field");
    var wf = seq.rasterize(0.5e-6);
    function gxAt(tUs) { return wf.gx[Math.round(tUs * 1e-6 / wf.dt)]; }
    almost(gxAt(10), 500, 5, "half way up the 20 us ramp");
    almost(gxAt(50), 1000, 1, "flat top");
    // Without time-shape support the waveform would have stopped after 4 raster steps
    // (40 us), so this sample is what proves the time shape is honoured.
    almost(gxAt(90), 500, 5, "half way down the ramp at 90 us");
    var moment = Pulseq.meanOver(wf, 0, wf.duration).gx * wf.duration;
    almost(moment, 1000 * 80e-6, 1000 * 80e-6 * 0.01, "trapezoid moment");
    console.log("ok time-shaped gradient: 100 us extended trapezoid, moment",
        moment.toFixed(5), "Hz/m*s");
})();

(function testTrajectoryFollowsTheRfPulses() {
    // The trajectory restarts at an excitation and inverts at a refocusing pulse, as in
    // Pulseq's own k-space calculation. Without both, a running integral from t=0 reports
    // a winding no spin ever carries.
    var cases = { "web4_RARE_16.seq": [1, 16], "web5_EPI_16.seq": [1, 0],
        "web3_FLASH_16.seq": [16, 0], "spiral_tse_ss.seq": [1, 4] };
    Object.keys(cases).forEach(function (file) {
        var seq = Pulseq.parse(readSeq(file));
        var wf = seq.rasterize(seq.suggestedRaster());
        assert.strictEqual(wf.excitationTimes.length, cases[file][0], file + " excitations");
        assert.strictEqual(wf.refocusTimes.length, cases[file][1], file + " refocusings");

        // Every RF time must sit inside the block that holds the pulse.
        var spans = [];
        var t = 0;
        for (var i = 0; i < seq.blocks.length; i++) {
            var dur = seq.blockDurationUs(seq.blocks[i]) * 1e-6;
            if (seq.blocks[i].rf) spans.push([t, t + dur]);
            t += dur;
        }
        wf.excitationTimes.concat(wf.refocusTimes).forEach(function (rt) {
            assert.ok(spans.some(function (s) { return rt > s[0] && rt < s[1]; }),
                file + ": RF time " + rt + " falls outside every RF block");
        });
    });

    // The echo train is the case that goes wrong without the inversions.
    var rare = Pulseq.parse(readSeq("web4_RARE_16.seq"));
    var rareWf = rare.rasterize(rare.suggestedRaster());
    var withRf = Pulseq.peakGradientTurns(rareWf);
    var naive = Pulseq.peakGradientTurns({
        n: rareWf.n, dt: rareWf.dt, cum: rareWf.cum, adcSampleTimes: []
    });
    assert.ok(withRf < 5, "RARE winding with the RF pulses: " + withRf.toFixed(2));
    assert.ok(naive > 10 * withRf, "ignoring RF should overstate it badly: " + naive.toFixed(1));
    console.log("ok trajectory follows RF: RARE winds " + withRf.toFixed(2) +
        " turns, " + naive.toFixed(1) + " if the RF pulses are ignored");
})();

(function testCartesianTrajectoryHitsTheTextbookGrid() {
    // The three Cartesian examples are 16x16 over a 1 m field of view, so every ADC
    // sample has to land on a 1 1/m grid, half a step off centre because Pulseq samples
    // at the middle of each dwell: kx sweeps -7.5 .. 7.5 and ky steps in whole units.
    // Nothing about the k-space calculation is free to be wrong and still pass this.
    ["web5_EPI_16.seq", "web3_FLASH_16.seq", "web4_RARE_16.seq"].forEach(function (file) {
        var seq = Pulseq.parse(readSeq(file));
        var wf = seq.rasterize(seq.suggestedRaster());
        var k = Pulseq.calculateKspace(wf);
        assert.strictEqual(k.tAdc.length, 16 * 16, file + " should hold 16 x 16 samples");

        var kxSeen = {};
        var kySeen = {};
        for (var i = 0; i < k.tAdc.length; i++) {
            var kx = k.kxAdc[i];
            var ky = k.kyAdc[i];
            almost(kx, Math.round(kx - 0.5) + 0.5, 0.02, file + " kx on the half-integer grid");
            almost(ky, Math.round(ky), 0.02, file + " ky on the integer grid");
            kxSeen[Math.round(kx - 0.5) + 0.5] = true;
            kySeen[Math.round(ky)] = true;
        }
        assert.strictEqual(Object.keys(kxSeen).length, 16, file + " distinct readout positions");
        assert.strictEqual(Object.keys(kySeen).length, 16, file + " distinct phase encodes");
        almost(k.radiusMaxAdc, Math.hypot(7.5, 8), 0.03, file + " corner of k-space");
        console.log("ok Cartesian k-space " + file + ": 16 x 16 samples, corner at " +
            k.radiusMaxAdc.toFixed(2) + " 1/m");
    });
})();

(function testV15Format() {
    // v1.5 inserted columns into the middle of the RF, gradient and ADC tables, so reading
    // one on the v1.4 layout takes the pulse centre for its delay and the first gradient
    // sample for its shape id — which parses cleanly and means nothing. The fixture is a
    // four-echo spin echo train written by pypulseq 1.5; every value asserted here is one
    // pypulseq's own calculate_kspace agrees with to the digit.
    var seq = Pulseq.parse(readFixture("v15_tse_8.seq"));
    assert.strictEqual(seq.version.code, 10500, "v1.5 file");
    assert.strictEqual(seq.version.newerThanParser, false, "v1.5 is within the parser");

    // The RF table: amplitudes still line up, so the flips come out right, and the centre
    // and use columns are picked up rather than being read as a delay.
    var flips = seq.summary().flips;
    assert.deepStrictEqual(flips, [180, 90, 60, 60, 60, 60], "flips through the v1.5 layout");
    var rf = seq.rf[seq.blocks.filter(function (b) { return b.rf; })[0].rf];
    almost(seq.rfCenterS(rf), 250e-6, 1e-9, "centre of the 500 us block pulse");
    assert.strictEqual(rf.delay, 0, "delay column, not the centre");

    // A shaped slice select proves the [GRADIENTS] first/last columns are consumed: read
    // as v1.4 the shape id would come out as the first sample value, leaving gz empty.
    var gz = seq.gradients[Object.keys(seq.gradients)[0]];
    almost(gz.amp, 4000, 1, "arbitrary gradient amplitude");
    assert.ok(seq.shapes[gz.shape_id] && seq.shapes[gz.shape_id].samples.length === 50,
        "shape id must point at the 50 sample slice select, got " + gz.shape_id);

    var wf = seq.rasterize(seq.suggestedRaster());
    var peakGz = 0;
    for (var i = 0; i < wf.n; i++) peakGz = Math.max(peakGz, Math.abs(wf.gz[i]));
    almost(peakGz, 4000, 5, "slice select has to reach the plane");

    // Pulseq puts sample i of an arbitrary gradient at (i + 0.5) rasters and runs the
    // event for the full n rasters, so its area is exactly raster * sum(samples). Reading
    // the first sample as if it sat at t=0 instead loses half a raster at either end.
    var samples = seq.shapes[gz.shape_id].samples;
    var sum = 0;
    for (var s = 0; s < samples.length; s++) sum += samples[s];
    var analytic = gz.amp * sum * seq.rasters.grad;
    var fine = seq.rasterize(0.05e-6);
    var area = Pulseq.meanOver(fine, 0, fine.duration).gz * fine.duration;
    almost(area, analytic, Math.abs(analytic) * 1e-4, "arbitrary gradient area");

    // The use field carries what the flip angle cannot: 60 degree refocusing pulses that
    // the flip-angle rule would call excitations, and a leading inversion pulse it would
    // call a refocusing. Trusting the angle here would restart the trajectory at every
    // echo and mirror one that does not exist yet.
    assert.strictEqual(wf.excitationTimes.length, 1, "one excitation, from the use field");
    assert.strictEqual(wf.refocusTimes.length, 4, "four refocusings, from the use field");
    almost(wf.excitationTimes[0], 5.75e-3, 1e-9, "excitation at its declared centre");
    var byAngle = flips.filter(function (f) { return f < 90.01; }).length;
    assert.strictEqual(byAngle, 5, "the flip angle alone would find 5 excitations here");

    // 8 samples per echo over a 1 m field of view, so every sample sits on a whole 1/m.
    var k = Pulseq.calculateKspace(wf);
    assert.strictEqual(k.tAdc.length, 32, "4 echoes of 8 samples");
    var expectKx = [-3.5, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3.5];
    for (var s = 0; s < 32; s++) {
        almost(k.kxAdc[s], expectKx[s % 8], 0.01, "kx sample " + s);
        almost(k.kyAdc[s], Math.floor(s / 8) - 1.5, 0.01, "ky sample " + s);
    }
    almost(k.radiusMaxAdc, Math.hypot(3.5, 1.5), 0.01, "corner of k-space");
    console.log("ok v1.5 format: flips " + flips.join("/") + ", 4 echoes of 8 samples on " +
        "the 1 1/m grid, corner at " + k.radiusMaxAdc.toFixed(4) + " 1/m");

    // A format past v1.5 has to be reported, not read on the newest layout we know.
    var future = Pulseq.parse(readFixture("v15_tse_8.seq").replace("minor 5", "minor 6"));
    assert.strictEqual(future.version.newerThanParser, true, "v1.6 is past the parser");
    console.log("ok unknown format flagged: v1.6 reports newerThanParser");
})();

(function testGradientDisplayFactor() {
    // Normalized display puts the same winding across the sample whatever field of view
    // and matrix a sequence was written for, so every example is comparable: the target is
    // five turns across the sample, held below what the isochromat grid can resolve.
    var PLANE_WIDTH = 8;     // scene units, from scenes.Plane in index.html
    var PLANE_SPACING = 0.4;
    var targetK = Pulseq.displayTargetK(PLANE_WIDTH, PLANE_SPACING);
    almost(targetK, 5 / (PLANE_WIDTH * 0.015), 1e-9, "five turns across the Plane sample");
    assert.ok(targetK < Pulseq.isocNyquistK(PLANE_SPACING),
        "the target has to stay under the grid's Nyquist limit");

    // A grid too coarse for five turns is capped by what it can actually resolve.
    almost(Pulseq.displayTargetK(PLANE_WIDTH, 2), Pulseq.isocNyquistK(2), 1e-9,
        "a coarse grid caps the target");
    assert.strictEqual(Pulseq.displayTargetK(0, PLANE_SPACING), 0, "no sample, no target");

    ["web5_EPI_16.seq", "web3_FLASH_16.seq", "web4_RARE_16.seq", "spiral_tse_ss.seq"]
        .forEach(function (file) {
            var seq = Pulseq.parse(readSeq(file));
            var wf = seq.rasterize(seq.suggestedRaster());
            var k = Pulseq.calculateKspace(wf);
            var factor = Pulseq.gradientDisplayFactor(wf, targetK);
            assert.ok(k.radiusMaxAdc > 0, file + " should acquire some k-space");
            almost(k.radiusMaxAdc * factor, targetK, targetK * 1e-9,
                file + " scaled ADC k-space should land on the target");
            almost(k.radiusMaxAdc * factor * PLANE_WIDTH * 0.015, 5, 1e-9,
                file + " should wind five turns across the sample");
            console.log("ok gradient scale " + file + ": ADC reaches " +
                k.radiusMaxAdc.toFixed(1) + " 1/m, scaled to " + targetK.toFixed(1) +
                " by ×" + factor.toPrecision(3));
        });

    // With no target the gradients play at their physical strength.
    var epi = Pulseq.parse(readSeq("web5_EPI_16.seq"));
    var epiWf = epi.rasterize(epi.suggestedRaster());
    assert.strictEqual(Pulseq.gradientDisplayFactor(epiWf, 0), 1, "EPI stays unscaled");
})();

(function testEnvelopeDecimationKeepsFastOscillations() {
    // A waveform oscillating every few samples is what made the spiral readout look like
    // noise: plain decimation lands on arbitrary phases, the envelope keeps the bounds.
    var n = 200000;
    var y = new Float64Array(n);
    for (var i = 0; i < n; i++) y[i] = Math.sin(i * Math.PI / 2); // period of 4 samples

    var maxPoints = 20000;
    var env = Pulseq.envelopeSeries(y, n, 0.001, maxPoints);
    assert.ok(env.y.length <= maxPoints, "output length " + env.y.length);

    var envMin = Infinity, envMax = -Infinity;
    for (var k = 0; k < env.y.length; k++) {
        envMin = Math.min(envMin, env.y[k]);
        envMax = Math.max(envMax, env.y[k]);
    }
    almost(envMin, -1, 0.01, "envelope keeps the trough");
    almost(envMax, 1, 0.01, "envelope keeps the peak");

    // Every bin must span nearly the full oscillation, not just wherever samples landed.
    var perBinSpans = [];
    for (var b = 0; b + 1 < env.y.length; b += 2) {
        perBinSpans.push(Math.abs(env.y[b + 1] - env.y[b]));
    }
    var worst = Math.min.apply(null, perBinSpans);
    assert.ok(worst > 1.5, "every bin should span the oscillation, worst " + worst.toFixed(3));

    for (var j = 1; j < env.x.length; j++) {
        assert.ok(env.x[j] >= env.x[j - 1], "x must not go backwards at " + j);
    }

    // Two channels of one sequence must come out on exactly the same x domain, whatever
    // their shape: the plot rows share a zoom window given as a percentage of it, so an
    // extent that differed by a bin would slide the rows apart as the zoom went in.
    var other = new Float64Array(n);
    for (var m = 0; m < n; m++) other[m] = (m % 7 === 0) ? 1 : 0; // extrema land elsewhere
    var envOther = Pulseq.envelopeSeries(other, n, 0.001, maxPoints);
    almost(env.x[0], 0, 0, "envelope starts at t=0");
    almost(env.x[env.x.length - 1], (n - 1) * 0.001, 1e-9, "envelope reaches the last sample");
    almost(envOther.x[0], env.x[0], 0, "both channels start together");
    almost(envOther.x[envOther.x.length - 1], env.x[env.x.length - 1], 0,
        "both channels end together");

    // Short inputs pass through untouched.
    var small = Pulseq.envelopeSeries(new Float64Array([0, 1, 2]), 3, 2, maxPoints);
    assert.deepStrictEqual(Array.from(small.x), [0, 2, 4], "x from index * dtX");
    assert.deepStrictEqual(Array.from(small.y), [0, 1, 2], "y passed through");
    console.log("ok envelope decimation:", env.y.length, "points, worst bin span",
        worst.toFixed(3), "of 2");
})();

(function testExampleGradientsStayPhysical() {
    // A .seq whose gradients exceed what a scanner can play is broken, not merely hard
    // to display: the spiral example had to be regenerated because its trajectory had
    // diverged to 2331 mT/m, twenty times past the limit its own generator declared.
    var HZ_PER_M_PER_MT_PER_M = 42.577e3; // 1 mT/m at gamma = 42.577 MHz/T
    var files = ["web3_FLASH_16.seq", "web4_RARE_16.seq", "web5_EPI_16.seq",
        "spiral_tse_ss.seq"];
    files.forEach(function (file) {
        var seq = Pulseq.parse(readSeq(file));
        var wf = seq.rasterize(seq.suggestedRaster());
        var peak = 0;
        for (var i = 0; i < wf.n; i++) {
            peak = Math.max(peak, Math.hypot(wf.gx[i], wf.gy[i], wf.gz[i]));
        }
        var mTm = peak / HZ_PER_M_PER_MT_PER_M;
        assert.ok(mTm < 80, file + " peak |G| " + mTm.toFixed(1) + " mT/m is not playable");
        console.log("ok physical gradients " + file + ": peak |G| " + mTm.toFixed(1) + " mT/m");
    });
})();

(function testSpinEchoCpmgAndNonCpmg() {
    var cpmg = Pulseq.parse(readSeq("web2_SpinEcho_me.seq"));
    var plain = Pulseq.parse(readSeq("web2_SpinEcho_nonCPMG.seq"));

    // Same timing and same flip angles; only the refocusing axis differs.
    almost(plain.summary().duration, cpmg.summary().duration, 1e-12, "same duration");
    assert.deepStrictEqual(plain.summary().flips, cpmg.summary().flips, "same flip angles");

    var cpmgPhases = Object.keys(cpmg.rf).map(function (k) { return cpmg.rf[k].phase; });
    var plainPhases = Object.keys(plain.rf).map(function (k) { return plain.rf[k].phase; });
    almost(cpmgPhases[1], Math.PI / 2, 1e-3, "CPMG refocuses 90 deg from the excitation");
    plainPhases.forEach(function (p, i) {
        assert.strictEqual(p, 0, "non-CPMG RF " + (i + 1) + " phase must be 0");
    });
    console.log("ok spin echo variants: CPMG phases", JSON.stringify(cpmgPhases),
        "vs non-CPMG", JSON.stringify(plainPhases));
})();

(function testShapeDecompressBlockPulse() {
    var samples = Pulseq.decompressShape([1, 0, 0, 997, -1, 0, 0, 17], 1020);
    assert.strictEqual(samples.length, 1020);
    var ones = 0;
    for (var i = 0; i < samples.length; i++) if (Math.abs(samples[i] - 1) < 1e-9) ones++;
    assert.ok(ones >= 990 && ones <= 1010, "block pulse ones=" + ones);

    // A run's third entry is a repeat count, not a value: [2,2,2,7] is four 2s then a 7,
    // and reading the count as a value made the integration run away.
    var run = Pulseq.decompressShape([2, 2, 2, 7], 0);
    assert.deepStrictEqual(run, [2, 4, 6, 8, 15], "run count must be consumed");

    // A shape whose entry count equals num_samples is stored raw, not integrated.
    assert.deepStrictEqual(Pulseq.decompressShape([0, 1, 1, 0], 4), [0, 1, 1, 0],
        "uncompressed shape passes through");
})();

(function testSpiralTseParsesAsRealTse() {
    // A v1.4.2 spiral TSE: exercises time-shaped gradients, long arbitrary spiral
    // waveforms and RLE-compressed RF shapes.
    var seq = Pulseq.parse(readSeq("spiral_tse_ss.seq"));
    var sum = seq.summary();
    assert.strictEqual(sum.version, "1.4.2");
    // Matches the TotalDuration the file declares, with the 0.5 s tail block removed.
    almost(sum.duration, 0.10491, 1e-9, "spiral TSE duration");
    assert.strictEqual(sum.nRf, 5);
    almost(sum.flips[0], 90, 0.5, "excitation");
    for (var i = 1; i < sum.flips.length; i++) almost(sum.flips[i], 180, 0.5, "refocus " + i);

    // CPMG: the refocusing axis is 90 degrees from the excitation, so the flip angle error
    // of each pulse alternates down the echo train instead of accumulating.
    var rfById = Object.keys(seq.rf).map(function (id) { return seq.rf[id]; });
    almost(rfById[0].phase, 0, 1e-4, "excitation phase");
    almost(rfById[1].phase, Math.PI / 2, 1e-4, "refocusing phase, 90 deg from excitation");

    // Both pulses are 1.25 ms and 1 ms of shape, at twice the amplitude the 2.5 ms and
    // 2 ms versions needed for the same flip angle.
    almost(seq._rfDurationUs(rfById[0]) - rfById[0].delay, 1250, 1, "excitation shape");
    almost(seq._rfDurationUs(rfById[1]) - rfById[1].delay, 1000, 1, "refocusing shape");

    // Normalized RF magnitude shapes are the tell-tale of correct decompression.
    for (var id in seq.rf) {
        var mag = seq.shapes[seq.rf[id].mag_id].samples;
        var peak = 0;
        for (var k = 0; k < mag.length; k++) peak = Math.max(peak, Math.abs(mag[k]));
        almost(peak, 1, 1e-6, "RF " + id + " magnitude shape should peak at 1");
    }

    var timeShaped = [];
    for (var g in seq.gradients) if (seq.gradients[g].time_id) timeShaped.push(g);
    assert.ok(timeShaped.length >= 4, "spiral TSE should use gradient time shapes");

    var wf = seq.rasterize(seq.suggestedRaster());
    var peakRf = 0, maxGx = 0, maxGy = 0, both = 0;
    for (var j = 0; j < wf.n; j++) {
        peakRf = Math.max(peakRf, Math.hypot(wf.rfRe[j], wf.rfIm[j]));
        maxGx = Math.max(maxGx, Math.abs(wf.gx[j]));
        maxGy = Math.max(maxGy, Math.abs(wf.gy[j]));
        if (Math.abs(wf.gx[j]) > 1 && Math.abs(wf.gy[j]) > 1) both++;
    }
    almost(peakRf, 1974.89, 2, "peak RF should match the [RF] amplitude");
    assert.ok(maxGx > 1e6 && maxGy > 1e6, "spiral gradients " + maxGx + " " + maxGy);
    assert.ok(both > 1000, "a spiral runs Gx and Gy together, samples: " + both);

    // The first readout has to trace a spiral out of the centre. A diverged trajectory
    // still accumulates some k-space, so the telling difference is that it reverses every
    // few raster steps and its radius wanders instead of growing.
    var gx = seq.gradients[8], gy = seq.gradients[9];
    var sx = seq.shapes[gx.shape_id].samples, sy = seq.shapes[gy.shape_id].samples;
    var kx = 0, ky = 0, radius = 0, turns = 0, prevAngle = 0, reversals = 0, shrank = 0;
    for (var s = 0; s < sx.length; s++) {
        kx += gx.amp * sx[s] * seq.rasters.grad;
        ky += gy.amp * sy[s] * seq.rasters.grad;
        var r = Math.hypot(kx, ky);
        if (r < radius) shrank++;
        radius = Math.max(radius, r);
        var angle = Math.atan2(ky, kx);
        var step = angle - prevAngle;
        while (step > Math.PI) step -= 2 * Math.PI;
        while (step < -Math.PI) step += 2 * Math.PI;
        turns += step;
        prevAngle = angle;
        if (s > 0 && sx[s] * sx[s - 1] < 0) reversals++;
    }
    turns = Math.abs(turns) / (2 * Math.PI);
    assert.ok(sx.length / Math.max(1, reversals) > 10,
        "readout gradient reverses every " + (sx.length / reversals).toFixed(1) +
        " raster steps, so it is not a trajectory");
    assert.ok(turns > 10, "first readout should wind out over many turns, got " + turns.toFixed(1));
    assert.ok(shrank < sx.length * 0.1,
        "a spiral-out radius should grow, it shrank on " + shrank + " of " + sx.length + " steps");
    console.log("ok spiral TSE:", sum.nBlocks, "blocks,", (sum.duration * 1000).toFixed(1),
        "ms, flips", sum.flips.join("/"), ", time-shaped gradients", timeShaped.join(","),
        ", oblique samples", both);
    console.log("ok spiral trajectory: first readout winds " + turns.toFixed(1) +
        " turns out to " + radius.toFixed(0) + " 1/m, reversing every " +
        (sx.length / reversals).toFixed(0) + " raster steps");
})();

console.log("All pulseq tests passed.");
