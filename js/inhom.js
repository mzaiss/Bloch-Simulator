/**
 * Field-offset distribution behind the T2' scenes of the Bloch Simulator.
 * Works in the browser (window.Inhom) and in Node (module.exports).
 *
 * A sample whose spins sit at a Cauchy (Lorentzian) spread of frequencies has an FID
 * envelope of exp(-t/T2'), with T2' the reciprocal of the spread's half width at half
 * maximum in rad/s. That is the whole of T2' here: the offsets are static, so a 180
 * degree pulse undoes them, which is what separates T2' from the irreversible T2.
 *
 * The spins are placed at evenly spaced quantiles of the distribution rather than drawn
 * at random, so that a nine-arrow fan looks like the distribution it stands for.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    root.Inhom = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /**
     * How much of the distribution is sampled, as a fraction of the whole. The tails are
     * left out because the Cauchy has no finite width to sample: at nine spins the
     * outermost one would sit 15 times further out than its neighbour, and that single
     * arrow would race away on its own instead of reading as a fan.
     */
    var SAMPLED_FRACTION = 1 / 1.5;
    /**
     * Ratio of the 1/e time of the fan's FID to the T2' its width implies. Cutting the
     * tails removes the fast spins that would carry the early decay, so the signal takes
     * this much longer to fall than exp(-t/T2') does, and falls off a cliff rather than
     * exponentially once it goes. It is a property of the sampled fraction alone: more
     * spins converge on the same 1.66 rather than on 1.
     */
    var TRUNCATION_FACTOR = 1.662;

    /**
     * The n probabilities sampled: evenly spaced, centred on the median, spanning
     * SAMPLED_FRACTION of the distribution.
     */
    function quantiles(n) {
        var out = [];
        for (var i = 0; i < n; i++) {
            out.push(0.5 + SAMPLED_FRACTION * (i - (n - 1) / 2) / n);
        }
        return out;
    }

    /**
     * Frequency offsets of an n-spin fan, in units of the distribution's half width at
     * half maximum, so scaling by hwhm() is all a change of T2' takes. This is the Cauchy
     * quantile function, tan(pi (p - 1/2)).
     */
    function unitOffsets(n) {
        var p = quantiles(n), out = [];
        for (var i = 0; i < n; i++) {
            out.push(Math.tan(Math.PI * (p[i] - 0.5)));
        }
        return out;
    }

    /**
     * Half width at half maximum, in the field units the simulator gives an isochromate
     * as dB0, of the distribution whose FID decays with T2' seconds. A T2' that is not a
     * positive finite number is read as no spread at all.
     */
    function hwhm(t2dash, gamma) {
        if (!(t2dash > 0) || t2dash === Infinity) return 0;
        return 1 / ((gamma || 1) * t2dash);
    }

    return {
        SAMPLED_FRACTION: SAMPLED_FRACTION,
        TRUNCATION_FACTOR: TRUNCATION_FACTOR,
        quantiles: quantiles,
        unitOffsets: unitOffsets,
        hwhm: hwhm
    };
});
