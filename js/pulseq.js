/**
 * Pulseq .seq parser and waveform rasterizer for the Bloch Simulator.
 * Works in the browser (window.Pulseq) and in Node (module.exports).
 *
 * Based on the BlochSimWeb loader in mzaiss/MRTwin_pulseq, extended for
 * v1.3+ duration-style blocks, arbitrary gradients, and seq.plot waveforms.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    root.Pulseq = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    var RF_RASTER = 1e-6;
    var GRAD_RASTER = 10e-6;
    var BLOCK_RASTER = 10e-6;

    var INTEGRATED_CHANNELS = ["rfRe", "rfIm", "gx", "gy", "gz"];
    /** Upper bound on rasterized samples, so a long sequence stays within a few tens of MB. */
    var MAX_RASTER_SAMPLES = 300000;
    /** Matches gradScale in index.html (isochromat detuning = G*pos/gradScale). */
    var DEFAULT_GRAD_SCALE = 11;
    /** Physical size of one scene unit; sets how strongly a gradient dephases the sample. */
    var METRES_PER_SCENE_UNIT = 0.015;
    /** Half-width of the Plane sample, in scene units. */
    var PLANE_EDGE_UNITS = 4;
    /** Winding across that half-width that still reads as stripes rather than noise. */
    var TARGET_GRAD_TURNS = 2;
    /** Below this many raster steps per oscillation a gradient waveform is under-sampled. */
    var MIN_GRAD_RASTERS_PER_OSCILLATION = 8;
    /** Smoothing applied to such a waveform: window multiple of the oscillation, passes. */
    var UNDERSAMPLED_SMOOTH_WINDOWS = 2;
    var UNDERSAMPLED_SMOOTH_PASSES = 3;

    function parseVersionNumber(lines) {
        var major = 0, minor = 0, revision = 0;
        for (var i = 0; i < lines.length; i++) {
            var parts = lines[i].split(/\s+/);
            if (parts[0] === "major") major = parseInt(parts[1], 10);
            else if (parts[0] === "minor") minor = parseInt(parts[1], 10);
            else if (parts[0] === "revision") revision = parseInt(parts[1], 10);
        }
        return { major: major, minor: minor, revision: revision, code: major * 10000 + minor * 100 + revision };
    }

    function parseDefinitions(lines) {
        var def = {};
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var sp = line.indexOf(" ");
            if (sp < 0) continue;
            def[line.slice(0, sp)] = line.slice(sp + 1).trim();
        }
        return def;
    }

    /**
     * Pulseq shape decoding, following the reference implementation: a shape holding
     * exactly num_samples entries is stored raw, otherwise the entries are the derivative
     * run-length encoded, where two equal values open a run and the entry after them is
     * the count of *additional* repeats. That third entry must be consumed, not read as a
     * value, or the integration runs away.
     */
    function decompressShape(compressed, expectedCount) {
        if (expectedCount > 0 && compressed.length === expectedCount) return compressed.slice();

        var deriv = [];
        var i = 0;
        while (i < compressed.length) {
            var value = compressed[i];
            deriv.push(value);
            if (i + 1 < compressed.length && compressed[i + 1] === value) {
                deriv.push(value);
                var extra = i + 2 < compressed.length ? compressed[i + 2] : 0;
                for (var r = 0; r < extra; r++) deriv.push(value);
                i += 3;
            } else {
                i += 1;
            }
        }

        var count = expectedCount > 0 ? Math.min(expectedCount, deriv.length) : deriv.length;
        var out = new Array(count);
        var acc = 0;
        for (var j = 0; j < count; j++) {
            acc += deriv[j];
            out[j] = acc;
        }
        return out;
    }

    function parseShapes(lines) {
        var shapes = {};
        var shape = null;
        var id = 0;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (/^shape_id/i.test(line)) {
                id = parseInt(line.replace(/^[^\d-]+/, ""), 10);
                shape = { count: -1, compressed: [] };
                shapes[id] = shape;
            } else if (shape && shape.count === -1) {
                shape.count = parseInt(line.split(/\s+/)[1], 10);
            } else if (shape) {
                shape.compressed.push(parseFloat(line));
            }
        }
        for (var key in shapes) {
            if (!Object.prototype.hasOwnProperty.call(shapes, key)) continue;
            var s = shapes[key];
            s.samples = decompressShape(s.compressed, s.count);
        }
        return shapes;
    }

    function parseNumericTable(lines, fields) {
        var events = {};
        for (var i = 0; i < lines.length; i++) {
            var ids = lines[i].split(/\s+/).filter(function (x) { return x.length > 0; });
            if (!ids.length) continue;
            var id = parseInt(ids[0], 10);
            var ev = {};
            for (var f = 0; f < fields.length; f++) {
                var spec = fields[f];
                if (f + 1 < ids.length) ev[spec.name] = spec.parse(ids[f + 1]);
                else ev[spec.name] = spec.def;
            }
            events[id] = ev;
        }
        return events;
    }

    var num = function (x) { return parseFloat(x); };
    var intp = function (x) { return parseInt(x, 10); };

    function parseRf(lines, versionCode) {
        // v1.2: amp mag_id phase_id delay freq phase
        // v1.4: amp mag_id phase_id time_id delay freq phase [use_gz]
        if (versionCode >= 10400) {
            return parseNumericTable(lines, [
                { name: "amp", parse: num, def: 0 },
                { name: "mag_id", parse: intp, def: 0 },
                { name: "phase_id", parse: intp, def: 0 },
                { name: "time_id", parse: intp, def: 0 },
                { name: "delay", parse: num, def: 0 },
                { name: "freq", parse: num, def: 0 },
                { name: "phase", parse: num, def: 0 }
            ]);
        }
        return parseNumericTable(lines, [
            { name: "amp", parse: num, def: 0 },
            { name: "mag_id", parse: intp, def: 0 },
            { name: "phase_id", parse: intp, def: 0 },
            { name: "delay", parse: num, def: 0 },
            { name: "freq", parse: num, def: 0 },
            { name: "phase", parse: num, def: 0 }
        ]);
    }

    function parseGradients(lines, versionCode) {
        if (versionCode >= 10400) {
            return parseNumericTable(lines, [
                { name: "amp", parse: num, def: 0 },
                { name: "shape_id", parse: intp, def: 0 },
                { name: "time_id", parse: intp, def: 0 },
                { name: "delay", parse: num, def: 0 }
            ]);
        }
        return parseNumericTable(lines, [
            { name: "amp", parse: num, def: 0 },
            { name: "shape_id", parse: intp, def: 0 },
            { name: "delay", parse: num, def: 0 }
        ]);
    }

    function parseSections(text) {
        var raw = text.split(/\r?\n/).map(function (l) { return l.trim(); })
            .filter(function (l) { return l.length > 0 && l[0] !== "#"; });
        var sections = {};
        var current = null;
        for (var i = 0; i < raw.length; i++) {
            var line = raw[i];
            if (line[0] === "[") {
                current = line.slice(1, -1).toUpperCase();
                sections[current] = [];
            } else if (current) {
                sections[current].push(line);
            }
        }
        return sections;
    }

    function rastersFromDefinitions(def) {
        function sec(name, fallback) {
            if (!def || def[name] == null) return fallback;
            var v = parseFloat(def[name]);
            return isFinite(v) && v > 0 ? v : fallback;
        }
        return {
            rf: sec("RadiofrequencyRasterTime", RF_RASTER),
            grad: sec("GradientRasterTime", GRAD_RASTER),
            adc: sec("AdcRasterTime", 1e-7),
            block: sec("BlockDurationRaster", BLOCK_RASTER)
        };
    }

    function shapeSamples(shapes, id) {
        if (!id || !shapes || !shapes[id]) return [];
        return shapes[id].samples || [];
    }

    function trapValue(trap, tRel) {
        var rise = trap.rise * 1e-6;
        var flat = trap.flat * 1e-6;
        var fall = trap.fall * 1e-6;
        if (tRel < 0 || tRel > rise + flat + fall) return 0;
        if (tRel < rise) return rise > 0 ? trap.amp * (tRel / rise) : trap.amp;
        if (tRel < rise + flat) return trap.amp;
        if (fall <= 0) return 0;
        return trap.amp * (1 - (tRel - rise - flat) / fall);
    }

    function interpShape(samples, index) {
        if (!samples.length) return 0;
        if (index <= 0) return samples[0];
        if (index >= samples.length - 1) return samples[samples.length - 1];
        var i0 = Math.floor(index);
        var f = index - i0;
        return samples[i0] * (1 - f) + samples[i0 + 1] * f;
    }

    /**
     * Sample times of a Pulseq time shape, in seconds. From v1.4 an RF or gradient event
     * may carry a time_id, whose shape holds the sample times in raster units instead of
     * the samples sitting on a uniform raster (this is how extended trapezoids and other
     * non-uniform gradient shapes are stored).
     */
    function shapeTimes(shapes, id, raster) {
        if (!id) return null;
        var s = shapeSamples(shapes, id);
        if (!s.length) return null;
        var out = new Array(s.length);
        for (var i = 0; i < s.length; i++) out[i] = s[i] * raster;
        return out;
    }

    /** Trapezoid integration weight of sample i within a non-uniform time shape. */
    function sampleWidth(times, i) {
        var n = times.length;
        if (n < 2) return 0;
        var prev = i > 0 ? times[i] - times[i - 1] : 0;
        var next = i < n - 1 ? times[i + 1] - times[i] : 0;
        return (prev + next) / 2;
    }

    /** Piecewise-linear value at time t for samples taken at explicit (monotonic) times. */
    function interpAtTimes(times, values, t) {
        var n = Math.min(times.length, values.length);
        if (!n) return 0;
        if (t < times[0] || t > times[n - 1]) return 0;
        var lo = 0;
        var hi = n - 1;
        while (hi - lo > 1) {
            var mid = (lo + hi) >> 1;
            if (times[mid] <= t) lo = mid;
            else hi = mid;
        }
        var span = times[hi] - times[lo];
        if (span <= 0) return values[lo];
        var f = (t - times[lo]) / span;
        return values[lo] * (1 - f) + values[hi] * f;
    }

    function Sequence(text) {
        var sections = parseSections(text);
        this.version = parseVersionNumber(sections.VERSION || []);
        this.definitions = parseDefinitions(sections.DEFINITIONS || []);
        this.rasters = rastersFromDefinitions(this.definitions);
        this.shapes = parseShapes(sections.SHAPES || []);
        this.rf = parseRf(sections.RF || [], this.version.code);
        this.gradients = parseGradients(sections.GRADIENTS || [], this.version.code);
        this.trap = parseNumericTable(sections.TRAP || [], [
            { name: "amp", parse: num, def: 0 },
            { name: "rise", parse: num, def: 0 },
            { name: "flat", parse: num, def: 0 },
            { name: "fall", parse: num, def: 0 },
            { name: "delay", parse: num, def: 0 }
        ]);
        this.adc = parseNumericTable(sections.ADC || [], [
            { name: "num", parse: intp, def: 0 },
            { name: "dwell", parse: num, def: 0 },
            { name: "delay", parse: num, def: 0 },
            { name: "freq", parse: num, def: 0 },
            { name: "phase", parse: num, def: 0 }
        ]);
        this.delays = parseNumericTable(sections.DELAYS || [], [
            { name: "delay", parse: intp, def: 0 }
        ]);
        this.blocks = this._parseBlocks(sections.BLOCKS || []);
        this.name = (this.definitions.Name || this.definitions.name || "sequence").trim();
    }

    Sequence.prototype._parseBlocks = function (lines) {
        var useDuration = this.version.code >= 10300;
        var blocks = [];
        for (var i = 0; i < lines.length; i++) {
            var ids = lines[i].split(/\s+/).filter(function (x) { return x.length > 0; });
            if (ids.length < 6) continue;
            var b = {
                id: parseInt(ids[0], 10),
                delay: 0,
                durationUs: 0,
                rf: parseInt(ids[2], 10) || 0,
                gx: parseInt(ids[3], 10) || 0,
                gy: parseInt(ids[4], 10) || 0,
                gz: parseInt(ids[5], 10) || 0,
                adc: ids.length > 6 ? parseInt(ids[6], 10) || 0 : 0
            };
            if (useDuration) {
                b.durationUs = (parseFloat(ids[1]) || 0) * this.rasters.block * 1e6;
            } else {
                b.delay = parseInt(ids[1], 10) || 0;
            }
            blocks.push(b);
        }
        return blocks;
    };

    Sequence.prototype._rfDurationUs = function (rf) {
        if (!rf) return 0;
        var times = shapeTimes(this.shapes, rf.time_id, this.rasters.rf);
        if (times) return (rf.delay || 0) + times[times.length - 1] * 1e6;
        var mag = shapeSamples(this.shapes, rf.mag_id);
        return (rf.delay || 0) + mag.length * this.rasters.rf * 1e6;
    };

    Sequence.prototype._gradDurationUs = function (id) {
        if (!id) return 0;
        if (this.trap[id]) {
            var t = this.trap[id];
            return (t.delay || 0) + (t.rise || 0) + (t.flat || 0) + (t.fall || 0);
        }
        if (this.gradients[id]) {
            var g = this.gradients[id];
            var times = shapeTimes(this.shapes, g.time_id, this.rasters.grad);
            if (times) return (g.delay || 0) + times[times.length - 1] * 1e6;
            var samples = shapeSamples(this.shapes, g.shape_id);
            return (g.delay || 0) + samples.length * this.rasters.grad * 1e6;
        }
        return 0;
    };

    /**
     * Raster for playback and plotting: half the finest raster the file declares, so
     * gradient corners and RF samples land on the grid, capped so a long sequence cannot
     * blow up memory.
     */
    Sequence.prototype.suggestedRaster = function () {
        var finest = Math.min(this.rasters.rf, this.rasters.grad) / 2;
        var totalUs = 0;
        for (var i = 0; i < this.blocks.length; i++) totalUs += this.blockDurationUs(this.blocks[i]);
        return Math.max(finest, totalUs * 1e-6 / MAX_RASTER_SAMPLES);
    };

    Sequence.prototype._adcDurationUs = function (adc) {
        if (!adc) return 0;
        return (adc.delay || 0) + adc.num * adc.dwell * 1e-3;
    };

    Sequence.prototype.blockDurationUs = function (block) {
        if (block.durationUs) return block.durationUs;
        var d = 0;
        if (block.delay && this.delays[block.delay]) d = Math.max(d, this.delays[block.delay].delay);
        if (block.rf) d = Math.max(d, this._rfDurationUs(this.rf[block.rf]));
        d = Math.max(d, this._gradDurationUs(block.gx));
        d = Math.max(d, this._gradDurationUs(block.gy));
        d = Math.max(d, this._gradDurationUs(block.gz));
        if (block.adc) d = Math.max(d, this._adcDurationUs(this.adc[block.adc]));
        return d;
    };

    /**
     * On-resonance flip angle. Pulseq keeps the magnitude shape non-negative and puts
     * sign changes (a sinc's side lobes) in the phase shape, so the lobes have to be
     * summed as vectors — summing magnitudes alone overstates the angle.
     */
    Sequence.prototype.rfFlipDeg = function (rf) {
        if (!rf) return 0;
        var mag = shapeSamples(this.shapes, rf.mag_id);
        var phs = shapeSamples(this.shapes, rf.phase_id);
        var times = shapeTimes(this.shapes, rf.time_id, this.rasters.rf);
        var re = 0;
        var im = 0;
        for (var i = 0; i < mag.length; i++) {
            var p = 2 * Math.PI * (i < phs.length ? phs[i] : 0);
            var width = times ? sampleWidth(times, i) : this.rasters.rf;
            re += mag[i] * Math.cos(p) * width;
            im += mag[i] * Math.sin(p) * width;
        }
        return rf.amp * Math.sqrt(re * re + im * im) * 360;
    };

    Sequence.prototype.summary = function () {
        var durationUs = 0;
        var nRf = 0, nAdc = 0, flips = [];
        for (var i = 0; i < this.blocks.length; i++) {
            var b = this.blocks[i];
            durationUs += this.blockDurationUs(b);
            if (b.rf) {
                nRf++;
                flips.push(Math.round(this.rfFlipDeg(this.rf[b.rf]) * 10) / 10);
            }
            if (b.adc) nAdc++;
        }
        return {
            name: this.name,
            version: this.version.major + "." + this.version.minor + "." + this.version.revision,
            nBlocks: this.blocks.length,
            nRf: nRf,
            nAdc: nAdc,
            duration: durationUs * 1e-6,
            flips: flips
        };
    };

    Sequence.prototype._evalGrad = function (id, tRel) {
        if (!id) return 0;
        if (this.trap[id]) {
            var tr = this.trap[id];
            return trapValue(tr, tRel - (tr.delay || 0) * 1e-6);
        }
        if (this.gradients[id]) {
            var g = this.gradients[id];
            var samples = shapeSamples(this.shapes, g.shape_id);
            var local = tRel - (g.delay || 0) * 1e-6;
            if (local < 0) return 0;
            var times = shapeTimes(this.shapes, g.time_id, this.rasters.grad);
            if (times) return g.amp * interpAtTimes(times, samples, local);
            var idx = local / this.rasters.grad;
            if (idx >= samples.length) return 0;
            return g.amp * interpShape(samples, idx);
        }
        return 0;
    };

    Sequence.prototype._evalRf = function (rf, tRel) {
        var off = { re: 0, im: 0, amp: 0, phase: 0 };
        if (!rf) return off;
        var local = tRel - (rf.delay || 0) * 1e-6;
        if (local < 0) return off;
        var mag = shapeSamples(this.shapes, rf.mag_id);
        var phs = shapeSamples(this.shapes, rf.phase_id);
        var times = shapeTimes(this.shapes, rf.time_id, this.rasters.rf);
        var m, p;
        if (times) {
            if (local > times[times.length - 1]) return off;
            m = interpAtTimes(times, mag, local);
            p = phs.length ? interpAtTimes(times, phs, local) : 0;
        } else {
            var idx = local / this.rasters.rf;
            if (idx >= mag.length) return off;
            m = interpShape(mag, idx);
            p = phs.length ? interpShape(phs, idx) : 0;
        }
        var phase = (rf.phase || 0) + 2 * Math.PI * p + 2 * Math.PI * (rf.freq || 0) * local;
        var a = rf.amp * m;
        return { re: a * Math.cos(phase), im: a * Math.sin(phase), amp: a, phase: phase };
    };

    /**
     * Rasterize the sequence onto a uniform time grid (seconds).
     * Returns waveforms used both for seq.plot and Bloch playback.
     */
    Sequence.prototype.rasterize = function (dt) {
        dt = dt || this.suggestedRaster();
        var duration = 0;
        var blockStarts = [];
        var blockEnds = [];
        for (var i = 0; i < this.blocks.length; i++) {
            blockStarts.push(duration);
            duration += this.blockDurationUs(this.blocks[i]) * 1e-6;
            blockEnds.push(duration);
        }
        var n = Math.max(2, Math.ceil(duration / dt) + 1);
        var rfRe = new Float64Array(n);
        var rfIm = new Float64Array(n);
        var gx = new Float64Array(n);
        var gy = new Float64Array(n);
        var gz = new Float64Array(n);
        var adc = new Float64Array(n);

        var bIdx = 0;
        for (var k = 0; k < n; k++) {
            var tk = k * dt;
            if (tk > duration) continue;
            while (bIdx < this.blocks.length - 1 && tk >= blockEnds[bIdx]) bIdx++;
            var block = this.blocks[bIdx];
            var tRel = tk - blockStarts[bIdx];
            if (block.rf) {
                var rf = this._evalRf(this.rf[block.rf], tRel);
                rfRe[k] = rf.re;
                rfIm[k] = rf.im;
            }
            gx[k] = this._evalGrad(block.gx, tRel);
            gy[k] = this._evalGrad(block.gy, tRel);
            gz[k] = this._evalGrad(block.gz, tRel);
            if (block.adc && this.adc[block.adc]) {
                var a = this.adc[block.adc];
                var a0 = (a.delay || 0) * 1e-6;
                var a1 = a0 + a.num * a.dwell * 1e-9;
                adc[k] = (tRel >= a0 && tRel < a1) ? 1 : 0;
            }
        }

        return buildIntegrals({
            dt: dt,
            duration: duration,
            n: n,
            rfRe: rfRe,
            rfIm: rfIm,
            gx: gx,
            gy: gy,
            gz: gz,
            adc: adc
        });
    };

    /**
     * Cumulative trapezoid integrals of every played channel, so the mean over an
     * arbitrary interval costs O(1). Playback integrates rather than point-samples:
     * a point sample of a 1 ms pulse or an oscillating EPI readout aliases badly once
     * a frame covers more sequence time than the feature itself.
     */
    function buildIntegrals(wf) {
        var cum = {};
        for (var k = 0; k < INTEGRATED_CHANNELS.length; k++) {
            var key = INTEGRATED_CHANNELS[k];
            var y = wf[key];
            var c = new Float64Array(wf.n);
            var acc = 0;
            for (var i = 1; i < wf.n; i++) {
                acc += 0.5 * (y[i - 1] + y[i]) * wf.dt;
                c[i] = acc;
            }
            cum[key] = c;
        }
        wf.cum = cum;
        return wf;
    }

    function integralAt(wf, key, t) {
        if (t <= 0) return 0;
        var y = wf[key];
        var c = wf.cum[key];
        var tEnd = (wf.n - 1) * wf.dt;
        if (t >= tEnd) return c[wf.n - 1];
        var idx = t / wf.dt;
        var i0 = Math.floor(idx);
        var f = idx - i0;
        var y0 = y[i0];
        var yt = y0 + (y[i0 + 1] - y0) * f;
        return c[i0] + 0.5 * (y0 + yt) * f * wf.dt;
    }

    /** Time-average of each channel over [t0,t1]; exact for the piecewise-linear raster. */
    function meanOver(wf, t0, t1) {
        var out = { rfRe: 0, rfIm: 0, gx: 0, gy: 0, gz: 0, adc: 0 };
        var span = t1 - t0;
        if (!wf || !wf.cum || !(span > 0)) return out;
        for (var k = 0; k < INTEGRATED_CHANNELS.length; k++) {
            var key = INTEGRATED_CHANNELS[k];
            out[key] = (integralAt(wf, key, t1) - integralAt(wf, key, t0)) / span;
        }
        var mid = Math.round((t0 + t1) / 2 / wf.dt);
        out.adc = wf.adc[Math.min(wf.n - 1, Math.max(0, mid))];
        return out;
    }

    /**
     * Pulseq RF amplitude [Hz] -> educational B1. Dividing by the playback stretch makes
     * the flip angle depend only on the sequence, not on playback speed or frame rate.
     */
    function rfToEdu(ampHz, stretch) {
        return (2 * Math.PI * ampHz) / stretch;
    }

    /**
     * Pulseq gradient [Hz/m] -> educational Gx/Gy, which the simulator turns into a
     * detuning of G*pos/gradScale. Also divided by the stretch, so a gradient lobe always
     * winds the same phase across the sample. METRES_PER_SCENE_UNIT sets the sample size:
     * at 15 mm/unit an EPI readout lobe winds about one turn across the Plane.
     */
    function gradToEdu(gHzPerM, stretch, gradScale) {
        return (2 * Math.PI * (gradScale || DEFAULT_GRAD_SCALE) *
            METRES_PER_SCENE_UNIT * gHzPerM) / stretch;
    }

    /**
     * Period of the fastest gradient oscillation actually present, in seconds, estimated
     * from sign changes over the span where gradients are active.
     */
    function gradientOscillationPeriod(wf) {
        var changes = 0;
        var first = -1;
        var last = -1;
        for (var i = 0; i < wf.n; i++) {
            var g = Math.abs(wf.gx[i]) + Math.abs(wf.gy[i]) + Math.abs(wf.gz[i]);
            if (g > 1e-9) {
                if (first < 0) first = i;
                last = i;
            }
            if (i > 0 && wf.gx[i] * wf.gx[i - 1] < 0) changes++;
        }
        if (first < 0 || changes === 0) return Infinity;
        return 2 * (last - first + 1) * wf.dt / changes;
    }

    /**
     * A gradient cannot physically turn over in a couple of raster steps, so a waveform
     * that does was written below its own Nyquist: its k-space trajectory zig-zags instead
     * of tracing a path. Reported so the panel can say so rather than looking broken.
     */
    function gradientSampling(wf, gradRaster) {
        var period = gradientOscillationPeriod(wf);
        var rasters = period / (gradRaster || GRAD_RASTER);
        return {
            period: period,
            rasters: rasters,
            undersampled: rasters < MIN_GRAD_RASTERS_PER_OSCILLATION
        };
    }

    /**
     * Box-car smooth the gradient channels over `windowS` seconds, repeated `passes`
     * times. Averaging is a convolution, so the gradient moment — the k-space trajectory
     * the spins actually follow — is preserved; what goes away is the ripple that the
     * file's raster could not represent and that otherwise makes the spins jitter.
     */
    function smoothGradients(wf, windowS, passes) {
        var half = Math.max(1, Math.round(windowS / wf.dt / 2));
        var n = wf.n;
        var prefix = new Float64Array(n + 1);
        var channels = ["gx", "gy", "gz"];
        for (var c = 0; c < channels.length; c++) {
            var y = wf[channels[c]];
            for (var p = 0; p < (passes || 1); p++) {
                prefix[0] = 0;
                for (var i = 0; i < n; i++) prefix[i + 1] = prefix[i] + y[i];
                for (var j = 0; j < n; j++) {
                    var a = j - half > 0 ? j - half : 0;
                    var b = j + half + 1 < n ? j + half + 1 : n;
                    y[j] = (prefix[b] - prefix[a]) / (b - a);
                }
            }
        }
        return buildIntegrals(wf);
    }

    /** Largest phase winding, in turns, the sequence puts across the edge of the sample. */
    function peakGradientTurns(wf) {
        var kx = 0;
        var ky = 0;
        var peak = 0;
        for (var i = 1; i < wf.n; i++) {
            kx += 0.5 * (wf.gx[i - 1] + wf.gx[i]) * wf.dt;
            ky += 0.5 * (wf.gy[i - 1] + wf.gy[i]) * wf.dt;
            var r = Math.sqrt(kx * kx + ky * ky);
            if (r > peak) peak = r;
        }
        return peak * PLANE_EDGE_UNITS * METRES_PER_SCENE_UNIT;
    }

    /**
     * Factor applied to gradients for display. The sample is only ~20 isochromats across,
     * so a sequence whose k-space excursion winds far more than a couple of turns over it
     * shows nothing but aliasing — and no playback speed helps, since the total phase is
     * what is large. Sequences under the target keep the plain physical scale, so their
     * dephasing stays comparable with each other.
     */
    function gradientDisplayFactor(wf) {
        var turns = peakGradientTurns(wf);
        return turns > TARGET_GRAD_TURNS ? TARGET_GRAD_TURNS / turns : 1;
    }

    /**
     * Min/max envelope decimation for plotting. Picking every Nth sample aliases a fast
     * waveform — a spiral readout came out looking like noise — so each output bin instead
     * contributes the smallest and largest sample it covers, in the order they occur.
     * Every raster sample is accounted for, and the drawn line is the true envelope.
     * Returns x in the units of dtX (so pass dt*1000 to plot milliseconds).
     */
    function envelopeSeries(y, n, dtX, maxPoints) {
        maxPoints = maxPoints || 20000;
        if (n <= maxPoints) {
            var xs = new Float64Array(n);
            for (var i = 0; i < n; i++) xs[i] = i * dtX;
            return { x: xs, y: y.subarray ? y.subarray(0, n) : y.slice(0, n) };
        }
        var bins = Math.floor(maxPoints / 2);
        var per = Math.ceil(n / bins);
        var outX = new Float64Array(bins * 2);
        var outY = new Float64Array(bins * 2);
        var w = 0;
        for (var b = 0; b < bins; b++) {
            var start = b * per;
            if (start >= n) break;
            var end = Math.min(n, start + per);
            var lo = start;
            var hi = start;
            for (var k = start + 1; k < end; k++) {
                if (y[k] < y[lo]) lo = k;
                if (y[k] > y[hi]) hi = k;
            }
            var first = lo < hi ? lo : hi;
            var second = lo < hi ? hi : lo;
            outX[w] = first * dtX;
            outY[w++] = y[first];
            outX[w] = second * dtX;
            outY[w++] = y[second];
        }
        return { x: outX.subarray(0, w), y: outY.subarray(0, w) };
    }

    function parse(text) {
        return new Sequence(text);
    }

    return {
        parse: parse,
        Sequence: Sequence,
        meanOver: meanOver,
        rfToEdu: rfToEdu,
        gradToEdu: gradToEdu,
        peakGradientTurns: peakGradientTurns,
        gradientDisplayFactor: gradientDisplayFactor,
        gradientSampling: gradientSampling,
        smoothGradients: smoothGradients,
        UNDERSAMPLED_SMOOTH_WINDOWS: UNDERSAMPLED_SMOOTH_WINDOWS,
        UNDERSAMPLED_SMOOTH_PASSES: UNDERSAMPLED_SMOOTH_PASSES,
        envelopeSeries: envelopeSeries,
        decompressShape: decompressShape
    };
});
