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
    /**
     * Winding, in turns across the sample, that the outermost acquired k-space sample is
     * scaled to. Every sequence is held to the same figure, so a 16x16 Cartesian readout
     * over a 1 m field of view and a 120x120 spiral over 24 cm wind alike on screen
     * instead of differing by the 50x their gradients differ by. Half of what the 0.4-unit
     * isochromat grid can resolve, which leaves the stripes reading as stripes rather than
     * folding into moire.
     */
    var DISPLAY_TARGET_TURNS = 5;
    /**
     * A .seq file below v1.5 does not record what an RF pulse is for, so the k-space
     * calculation has to infer it. Pulses up to this flip angle count as excitation and
     * larger ones as refocusing, which is the rule pypulseq's read(detect_rf_use=True)
     * applies; the 0.01 covers a nominal 90 that rounds up through the shape quantization.
     */
    var EXCITATION_MAX_FLIP_DEG = 90.01;
    /**
     * What each v1.5 RF use letter does to the k-space trajectory. Inversion, saturation
     * and preparation pulses act on longitudinal magnetization, so there is no transverse
     * phase for them to restart or mirror and the trajectory runs on through them. That,
     * and a refocusing pulse driven below 90 degrees to save power, are the cases the flip
     * angle alone cannot tell apart.
     */
    var RF_USE = {
        e: "excite",
        r: "refocus",
        i: "ignore",
        s: "ignore",
        p: "ignore",
        o: "ignore"
    };

    /** Newest format whose event table layouts this parser knows, as major * 100 + minor. */
    var NEWEST_KNOWN_FORMAT = 105;

    function parseVersionNumber(lines) {
        var major = 0, minor = 0, revision = 0;
        for (var i = 0; i < lines.length; i++) {
            var parts = lines[i].split(/\s+/);
            if (parts[0] === "major") major = parseInt(parts[1], 10);
            else if (parts[0] === "minor") minor = parseInt(parts[1], 10);
            else if (parts[0] === "revision") revision = parseInt(parts[1], 10);
        }
        var code = major * 10000 + minor * 100 + revision;
        // Every revision so far has inserted columns into the event tables, so a newer one
        // has to be reported rather than read on the newest layout we happen to know.
        return {
            major: major, minor: minor, revision: revision, code: code,
            newerThanParser: major * 100 + minor > NEWEST_KNOWN_FORMAT
        };
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
    var text = function (x) { return x; };

    /**
     * Each format revision inserted columns into the middle of the event tables, so the
     * layout has to be chosen by version: reading a v1.5 file as v1.4 takes the pulse
     * centre for its delay and the first gradient sample for its shape id, which parses
     * without complaint and means nothing.
     */
    function parseRf(lines, versionCode) {
        // v1.2: amp mag_id phase_id delay freq phase
        // v1.4: amp mag_id phase_id time_id delay freq phase
        // v1.5: amp mag_id phase_id time_id center delay freq_ppm phase_ppm freq phase use
        if (versionCode >= 10500) {
            return parseNumericTable(lines, [
                { name: "amp", parse: num, def: 0 },
                { name: "mag_id", parse: intp, def: 0 },
                { name: "phase_id", parse: intp, def: 0 },
                { name: "time_id", parse: intp, def: 0 },
                { name: "center", parse: num, def: 0 },
                { name: "delay", parse: num, def: 0 },
                { name: "freq_ppm", parse: num, def: 0 },
                { name: "phase_ppm", parse: num, def: 0 },
                { name: "freq", parse: num, def: 0 },
                { name: "phase", parse: num, def: 0 },
                { name: "use", parse: text, def: "" }
            ]);
        }
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
        // v1.5 states the waveform value at the very start and end of the event, which
        // the raster already carries, so the columns are read only to reach the shape ids.
        if (versionCode >= 10500) {
            return parseNumericTable(lines, [
                { name: "amp", parse: num, def: 0 },
                { name: "first", parse: num, def: 0 },
                { name: "last", parse: num, def: 0 },
                { name: "shape_id", parse: intp, def: 0 },
                { name: "time_id", parse: intp, def: 0 },
                { name: "delay", parse: num, def: 0 }
            ]);
        }
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

    function parseAdc(lines, versionCode) {
        // v1.2/v1.4: num dwell delay freq phase
        // v1.5:      num dwell delay freq_ppm phase_ppm freq phase phase_id
        if (versionCode >= 10500) {
            return parseNumericTable(lines, [
                { name: "num", parse: intp, def: 0 },
                { name: "dwell", parse: num, def: 0 },
                { name: "delay", parse: num, def: 0 },
                { name: "freq_ppm", parse: num, def: 0 },
                { name: "phase_ppm", parse: num, def: 0 },
                { name: "freq", parse: num, def: 0 },
                { name: "phase", parse: num, def: 0 },
                { name: "phase_id", parse: intp, def: 0 }
            ]);
        }
        return parseNumericTable(lines, [
            { name: "num", parse: intp, def: 0 },
            { name: "dwell", parse: num, def: 0 },
            { name: "delay", parse: num, def: 0 },
            { name: "freq", parse: num, def: 0 },
            { name: "phase", parse: num, def: 0 }
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
        this.adc = parseAdc(sections.ADC || [], this.version.code);
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

    /**
     * When the rotation an RF pulse performs effectively happens, in seconds from the
     * start of the event, excluding its delay: the peak of the envelope, or the middle of
     * the plateau for a block pulse. Port of pypulseq's calc_rf_center.
     */
    Sequence.prototype.rfCenterS = function (rf) {
        if (!rf) return 0;
        // From v1.5 the file states this outright, which is the authority for a pulse
        // whose effective rotation does not sit under the peak of its envelope.
        if (rf.center > 0) return rf.center * 1e-6;
        var mag = shapeSamples(this.shapes, rf.mag_id);
        if (!mag.length) return 0;
        var times = shapeTimes(this.shapes, rf.time_id, this.rasters.rf);
        var peak = 0;
        var i;
        for (i = 0; i < mag.length; i++) peak = Math.max(peak, Math.abs(mag[i]));
        var first = -1;
        var last = -1;
        for (i = 0; i < mag.length; i++) {
            if (Math.abs(mag[i]) >= peak * 0.99999) {
                if (first < 0) first = i;
                last = i;
            }
        }
        if (first < 0) return 0;
        if (times) return (times[first] + times[last]) / 2;
        return (first + last + 1) / 2 * this.rasters.rf;
    };

    /**
     * Absolute times of the RF pulses, split by what they do to the k-space trajectory.
     * Port of pypulseq's Sequence.rf_times. A v1.5 file says what each pulse is for and is
     * taken at its word; below that the use is inferred from the flip angle, as described
     * at EXCITATION_MAX_FLIP_DEG.
     */
    Sequence.prototype.rfTimes = function () {
        var excitations = [];
        var refocusings = [];
        var t = 0;
        for (var i = 0; i < this.blocks.length; i++) {
            var b = this.blocks[i];
            var rf = b.rf ? this.rf[b.rf] : null;
            if (rf) {
                var use = RF_USE[rf.use];
                if (!use) {
                    use = Math.abs(this.rfFlipDeg(rf)) < EXCITATION_MAX_FLIP_DEG
                        ? "excite" : "refocus";
                }
                var centre = t + (rf.delay || 0) * 1e-6 + this.rfCenterS(rf);
                if (use === "excite") excitations.push(centre);
                else if (use === "refocus") refocusings.push(centre);
            }
            t += this.blockDurationUs(b) * 1e-6;
        }
        return { excitations: excitations, refocusings: refocusings };
    };

    /**
     * Absolute time of every ADC sample. Pulseq puts sample i at the centre of its dwell,
     * so the first one sits half a dwell after the ADC delay.
     */
    Sequence.prototype.adcTimes = function () {
        var out = [];
        var t = 0;
        for (var i = 0; i < this.blocks.length; i++) {
            var b = this.blocks[i];
            var adc = b.adc ? this.adc[b.adc] : null;
            if (adc) {
                var t0 = t + (adc.delay || 0) * 1e-6;
                var dwell = adc.dwell * 1e-9;
                for (var s = 0; s < adc.num; s++) out.push(t0 + (s + 0.5) * dwell);
            }
            t += this.blockDurationUs(b) * 1e-6;
        }
        return out;
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
            // With no time shape, Pulseq steps an arbitrary gradient at raster centres:
            // sample i covers [i, i+1] rasters and sits in the middle of that, so the
            // event runs the full n rasters and the outer half raster at either end holds
            // the first and last sample. Sampling as if the first one sat at t=0 instead
            // loses half a raster of area at each end of every shaped gradient.
            if (local > samples.length * this.rasters.grad) return 0;
            return g.amp * interpShape(samples, local / this.rasters.grad - 0.5);
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

        var rfTimes = this.rfTimes();
        var adcSampleTimes = this.adcTimes();

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
            adc: adc,
            excitationTimes: rfTimes.excitations,
            refocusTimes: rfTimes.refocusings,
            adcSampleTimes: adcSampleTimes
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
     * The k-space trajectory the gradients trace, in 1/m. Port of pypulseq's
     * Sequence.calculate_kspace: k is the running gradient moment plus an offset that is
     * constant between RF pulses, where an excitation restarts the trajectory at the
     * origin because it makes fresh transverse magnetization, and a refocusing pulse
     * mirrors it through the origin because it inverts the phase accrued so far
     * (dk = -2M - dk, pypulseq's own recursion). Both matter: a plain running integral
     * from t=0 reads the RARE example at 79 turns of winding where a spin carries 2.4.
     *
     * Reports the trajectory at the ADC sample points, which is the k-space the sequence
     * actually acquires and so the part that has to fit the sample for the readout to
     * mean anything, alongside the largest radius reached at any time.
     */
    function calculateKspace(wf) {
        var events = [];
        var exc = wf.excitationTimes || [];
        var ref = wf.refocusTimes || [];
        var i;
        for (i = 0; i < exc.length; i++) events.push({ t: exc[i], excite: true });
        for (i = 0; i < ref.length; i++) events.push({ t: ref[i], excite: false });
        events.sort(function (a, b) { return a.t - b.t; });

        var nEvents = events.length;
        var dkx = new Float64Array(nEvents + 1);
        var dky = new Float64Array(nEvents + 1);
        var dkz = new Float64Array(nEvents + 1);
        for (i = 0; i < nEvents; i++) {
            var te = events[i].t;
            var mx = integralAt(wf, "gx", te);
            var my = integralAt(wf, "gy", te);
            var mz = integralAt(wf, "gz", te);
            if (events[i].excite) {
                dkx[i + 1] = -mx;
                dky[i + 1] = -my;
                dkz[i + 1] = -mz;
            } else {
                dkx[i + 1] = -2 * mx - dkx[i];
                dky[i + 1] = -2 * my - dky[i];
                dkz[i + 1] = -2 * mz - dkz[i];
            }
        }

        // Trajectory at the ADC samples, in acquisition order.
        var tAdc = wf.adcSampleTimes || [];
        var nAdc = tAdc.length;
        var kxAdc = new Float64Array(nAdc);
        var kyAdc = new Float64Array(nAdc);
        var kzAdc = new Float64Array(nAdc);
        var radiusMaxAdc = 0;
        var p = 0;
        for (i = 0; i < nAdc; i++) {
            var t = tAdc[i];
            while (p < nEvents && t >= events[p].t) p++;
            kxAdc[i] = integralAt(wf, "gx", t) + dkx[p];
            kyAdc[i] = integralAt(wf, "gy", t) + dky[p];
            kzAdc[i] = integralAt(wf, "gz", t) + dkz[p];
            var rAdc = Math.sqrt(kxAdc[i] * kxAdc[i] + kyAdc[i] * kyAdc[i]);
            if (rAdc > radiusMaxAdc) radiusMaxAdc = rAdc;
        }

        // Largest in-plane radius over the whole trajectory, on the playback raster. The
        // cumulative integrals already hold the running moment at every raster point.
        var radiusMaxTraj = 0;
        var cx = wf.cum.gx;
        var cy = wf.cum.gy;
        p = 0;
        for (i = 0; i < wf.n; i++) {
            var tr = i * wf.dt;
            while (p < nEvents && tr >= events[p].t) p++;
            var kx = cx[i] + dkx[p];
            var ky = cy[i] + dky[p];
            var r = Math.sqrt(kx * kx + ky * ky);
            if (r > radiusMaxTraj) radiusMaxTraj = r;
        }

        return {
            excitations: exc,
            refocusings: ref,
            tAdc: tAdc,
            kxAdc: kxAdc,
            kyAdc: kyAdc,
            kzAdc: kzAdc,
            radiusMaxAdc: radiusMaxAdc,
            radiusMaxTraj: radiusMaxTraj
        };
    }

    /** Largest phase winding, in turns, the sequence puts across the edge of the sample. */
    function peakGradientTurns(wf) {
        return calculateKspace(wf).radiusMaxTraj * PLANE_EDGE_UNITS * METRES_PER_SCENE_UNIT;
    }

    /**
     * Highest spatial frequency an isochromat grid of the given spacing can carry, in 1/m.
     * Neighbours a distance apart cannot show more than half a turn between them, so this
     * is the sample's own Nyquist limit: past it the stripe pattern folds back and no
     * playback speed recovers it.
     */
    function isocNyquistK(spacingSceneUnits) {
        if (!(spacingSceneUnits > 0)) return Infinity;
        return 1 / (2 * spacingSceneUnits * METRES_PER_SCENE_UNIT);
    }

    /**
     * The k-space radius the display aims the readout at: the radius that winds
     * DISPLAY_TARGET_TURNS across a sample of the given width, or the grid's own Nyquist
     * limit where that is lower, since no gradient scale recovers a pattern the
     * isochromats cannot resolve.
     */
    function displayTargetK(widthSceneUnits, spacingSceneUnits, turns) {
        if (!(widthSceneUnits > 0)) return 0;
        if (!(turns > 0)) turns = DISPLAY_TARGET_TURNS;
        return Math.min(turns / (widthSceneUnits * METRES_PER_SCENE_UNIT),
            isocNyquistK(spacingSceneUnits));
    }

    /**
     * Factor applied to gradients for display, mapping the outermost k-space sample the
     * sequence acquires onto `targetK`. It scales both ways on purpose: what a sequence
     * asks of its gradients follows from the field of view and matrix it was written for,
     * neither of which our sample has, so a readout is amplified or damped until it winds
     * the intended amount across the isochromats we do have. Returns 1 with no target,
     * which plays the gradients at their physical strength.
     */
    function gradientDisplayFactor(wf, targetK) {
        if (!(targetK > 0) || !isFinite(targetK)) return 1;
        var reached = calculateKspace(wf).radiusMaxAdc;
        return reached > 0 ? targetK / reached : 1;
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
        // Each channel picks its own representative samples, so the ends of the series
        // land wherever its first and last extremum happen to be, up to a bin short of
        // the sequence. Pinning them puts every channel on one x domain, which is what
        // lets the plot rows share a zoom window expressed as a percentage of it.
        if (w > 1) {
            outX[0] = 0;
            outX[w - 1] = (n - 1) * dtX;
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
        calculateKspace: calculateKspace,
        isocNyquistK: isocNyquistK,
        displayTargetK: displayTargetK,
        gradientDisplayFactor: gradientDisplayFactor,
        envelopeSeries: envelopeSeries,
        decompressShape: decompressShape
    };
});
