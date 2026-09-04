"use strict";

var assert = require("assert");
var Inhom = require("../js/inhom.js");

function almost(a, b, tol, msg) {
    assert.ok(Math.abs(a - b) <= tol, (msg || "") + " expected " + b + " got " + a);
}

/** |S(t)| of a fan of static offsets, i.e. the FID envelope it produces. */
function fid(offsets, t, gamma) {
    var re = 0, im = 0;
    for (var i = 0; i < offsets.length; i++) {
        re += Math.cos((gamma || 1) * offsets[i] * t);
        im += Math.sin((gamma || 1) * offsets[i] * t);
    }
    return Math.hypot(re, im) / offsets.length;
}

function scaled(n, t2dash, gamma) {
    var unit = Inhom.unitOffsets(n), hwhm = Inhom.hwhm(t2dash, gamma), out = [];
    for (var i = 0; i < n; i++) out.push(unit[i] * hwhm);
    return out;
}

/** First time the envelope falls to a level, to 1 ms. */
function crossing(offsets, level, gamma) {
    for (var t = 0; t < 400; t += 0.001) if (fid(offsets, t, gamma) <= level) return t;
    return Infinity;
}

(function testQuantilesAreCauchy() {
    var p = Inhom.quantiles(9);
    assert.strictEqual(p.length, 9);
    almost(p[4], 0.5, 1e-15, "middle spin sits at the median");
    // Evenly spaced in probability: each spin stands for an equal share of the sampled
    // fraction and sits at the middle of its share, so the shares tile that fraction.
    var step = Inhom.SAMPLED_FRACTION / 9;
    for (var i = 1; i < 9; i++) almost(p[i] - p[i - 1], step, 1e-15, "step " + i);
    almost(step, 2 / 27, 1e-15, "share of each spin");
    almost((p[8] + step / 2) - (p[0] - step / 2), Inhom.SAMPLED_FRACTION, 1e-15, "span");
    almost(p[0], 0.203704, 1e-6, "first quantile");
    almost(p[8], 0.796296, 1e-6, "last quantile");
    // An even count leaves nobody on resonance, which is a legitimate fan.
    var even = Inhom.quantiles(8);
    assert.ok(even.every(function (q) { return q !== 0.5; }), "no median spin at n=8");
    console.log("ok quantiles: central", (100 * Inhom.SAMPLED_FRACTION).toFixed(3) +
        "% of the Cauchy, spins at", (100 * p[0]).toFixed(2) + "% through",
        (100 * p[8]).toFixed(2) + "%");
})();

(function testOffsetsMatchTheHardcodedSpread() {
    // The distribution the inhomogeneity scenes had before T2' was steerable, when the
    // width was the constant 1/6: unchanged, so those scenes still look as they did.
    var offsets = scaled(9, 6, 1);
    for (var i = 0; i < 9; i++) {
        var legacy = Math.tan((i - 4) / (9 / (Math.PI / 1.5))) / 6;
        almost(offsets[i], legacy, 1e-15, "offset " + i);
    }
    almost(offsets[8], 0.223872, 1e-6, "outermost offset");
    console.log("ok offsets: outermost", offsets[8].toFixed(6), "rad/s at T2'=6 s");
})();

(function testWidthIsReciprocalT2dash() {
    almost(Inhom.hwhm(6, 1), 1 / 6, 1e-15, "T2'=6 s at Gamma=1");
    almost(Inhom.hwhm(2, 1), 0.5, 1e-15, "T2'=2 s");
    // dB0 is a field, so the width in field units carries the reciprocal of Gamma.
    almost(Inhom.hwhm(6, 2), 1 / 12, 1e-15, "T2'=6 s at Gamma=2");
    // No spread, and hence no dephasing, for a T2' that is not a positive finite time.
    assert.strictEqual(Inhom.hwhm(Infinity, 1), 0, "T2' off");
    assert.strictEqual(Inhom.hwhm(0, 1), 0, "T2' of zero has no finite width");
    assert.strictEqual(Inhom.hwhm(-1, 1), 0, "negative T2'");
    console.log("ok width: HWHM 1/6 rad/s =",
        (1 / (12 * Math.PI)).toFixed(6), "Hz for the 6 s default");
})();

(function testFidDecaysWithTheWidth() {
    // Cutting the tails costs the early decay, so the fan takes TRUNCATION_FACTOR times
    // longer to reach 1/e than the exp(-t/T2') its width stands for. The factor belongs
    // to the sampled fraction, not to the spin count: it is the same for a fan of nine
    // and a fan of a thousand, so every scene decays alike.
    [9, 21, 1001].forEach(function (n) {
        var t = crossing(scaled(n, 6, 1), Math.exp(-1), 1);
        almost(t / 6, Inhom.TRUNCATION_FACTOR, 0.03, "1/e of " + n + " spins over T2'");
    });
    // Which leaves the decay a rescale of one curve, so T2' is the only knob needed.
    var shape = [0.5, 1, 1.662, 2.5];
    [0.5, 1, 6, 20].forEach(function (t2dash) {
        var offsets = scaled(9, t2dash, 1);
        shape.forEach(function (f) {
            almost(fid(offsets, f * t2dash, 1), fid(scaled(9, 6, 1), f * 6, 1), 1e-12,
                "|S| at " + f + " T2', T2'=" + t2dash);
        });
    });
    // And the FID window is 4 s, which is what makes the interesting range short: the
    // 6 s default barely droops within it, while a couple of seconds is gone by the end.
    almost(fid(scaled(9, 6, 1), 4, 1), 0.868, 0.002, "|S| at 4 s, T2'=6 s");
    almost(fid(scaled(9, 2, 1), 4, 1), 0.205, 0.002, "|S| at 4 s, T2'=2 s");
    assert.ok(fid(scaled(9, 0.5, 1), 4, 1) < 0.05, "T2'=0.5 s is gone by 4 s");
    // T2' off must hold the fan together indefinitely.
    almost(fid(scaled(9, Infinity, 1), 60, 1), 1, 1e-15, "no spread, no decay");
    console.log("ok decay: 1/e at", crossing(scaled(9, 6, 1), Math.exp(-1), 1).toFixed(3),
        "s for a nominal 6 s, factor", Inhom.TRUNCATION_FACTOR);
})();

(function testFastestSpinStaysResolvedPerFrame() {
    // The one numerical limit on the short end of the slider: the outermost spin must
    // turn well under half a turn between animation frames or it aliases on screen.
    var fastest = Math.max.apply(null, scaled(9, 0.5, 1).map(Math.abs));
    almost(fastest, 2.686, 0.001, "outermost offset at the 0.5 s minimum");
    assert.ok(fastest / 60 < 0.2, "rad per 60 fps frame " + (fastest / 60).toFixed(4));
    assert.ok(fastest / 12 < Math.PI, "rad per 12 fps frame " + (fastest / 12).toFixed(4));
    console.log("ok frames:", (fastest / 60).toFixed(4), "rad per frame at 60 fps,",
        (fastest / 12).toFixed(4), "at 12 fps");
})();

(function testSpinEchoUndoesTheSpread() {
    // What separates T2' from T2: the offsets are static, so a refocusing pulse turns
    // the accrued phase around and every spin arrives back together at the echo.
    var offsets = scaled(9, 2, 1), TEhalf = 3.3;
    assert.ok(fid(offsets, TEhalf, 1) < 0.4, "dephased by TE/2");
    var re = 0, im = 0;
    for (var i = 0; i < offsets.length; i++) {
        var phase = -offsets[i] * TEhalf;      // dephasing to the pulse
        phase = -phase;                        // the 180 degrees
        phase += -offsets[i] * TEhalf;         // and on to the echo
        re += Math.cos(phase); im += Math.sin(phase);
    }
    almost(Math.hypot(re, im) / offsets.length, 1, 1e-15, "echo amplitude");
    console.log("ok spin echo: |S| back to 1 from",
        fid(offsets, TEhalf, 1).toFixed(4), "at the echo");
})();

console.log("all inhom tests passed");
