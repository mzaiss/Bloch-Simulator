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

    function decompressShape(samples, expectedCount) {
        var temp = [];
        for (var idx = 0; idx < samples.length; idx++) {
            var value = samples[idx];
            if (temp.length >= 2 && samples[idx - 1] === samples[idx - 2]) {
                for (var r = 0; r < value; r++) temp.push(samples[idx - 1]);
            } else {
                temp.push(value);
            }
        }
        var out = new Array(temp.length);
        var acc = 0;
        for (var j = 0; j < temp.length; j++) {
            acc += temp[j];
            out[j] = acc;
        }
        if (expectedCount > 0 && out.length !== expectedCount) {
            // Some files store already-uncompressed samples. Fall back if RLE exploded.
            if (samples.length === expectedCount) return samples.slice();
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
        var mag = shapeSamples(this.shapes, rf.mag_id);
        var n = mag.length;
        var rasterUs = this.rasters.rf * 1e6;
        return (rf.delay || 0) + n * rasterUs;
    };

    Sequence.prototype._gradDurationUs = function (id) {
        if (!id) return 0;
        if (this.trap[id]) {
            var t = this.trap[id];
            return (t.delay || 0) + (t.rise || 0) + (t.flat || 0) + (t.fall || 0);
        }
        if (this.gradients[id]) {
            var g = this.gradients[id];
            var samples = shapeSamples(this.shapes, g.shape_id);
            return (g.delay || 0) + samples.length * this.rasters.grad * 1e6;
        }
        return 0;
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

    Sequence.prototype.rfFlipDeg = function (rf) {
        if (!rf) return 0;
        var mag = shapeSamples(this.shapes, rf.mag_id);
        var sum = 0;
        for (var i = 0; i < mag.length; i++) sum += mag[i];
        return rf.amp * sum * this.rasters.rf * 360;
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
            var idx = local / this.rasters.grad;
            if (idx >= samples.length) return 0;
            return g.amp * interpShape(samples, idx);
        }
        return 0;
    };

    Sequence.prototype._evalRf = function (rf, tRel) {
        if (!rf) return { re: 0, im: 0, amp: 0, phase: 0 };
        var local = tRel - (rf.delay || 0) * 1e-6;
        if (local < 0) return { re: 0, im: 0, amp: 0, phase: 0 };
        var mag = shapeSamples(this.shapes, rf.mag_id);
        var phs = shapeSamples(this.shapes, rf.phase_id);
        var idx = local / this.rasters.rf;
        if (idx >= mag.length) return { re: 0, im: 0, amp: 0, phase: 0 };
        var m = interpShape(mag, idx);
        var p = phs.length ? interpShape(phs, idx) : 0;
        var phase = (rf.phase || 0) + 2 * Math.PI * p + 2 * Math.PI * (rf.freq || 0) * local;
        var a = rf.amp * m;
        return { re: a * Math.cos(phase), im: a * Math.sin(phase), amp: a, phase: phase };
    };

    /**
     * Rasterize the sequence onto a uniform time grid (seconds).
     * Returns waveforms used both for seq.plot and Bloch playback.
     */
    Sequence.prototype.rasterize = function (dt) {
        dt = dt || 20e-6;
        var duration = 0;
        var blockStarts = [];
        for (var i = 0; i < this.blocks.length; i++) {
            blockStarts.push(duration);
            duration += this.blockDurationUs(this.blocks[i]) * 1e-6;
        }
        var n = Math.max(2, Math.ceil(duration / dt) + 1);
        var t = new Float64Array(n);
        var rfRe = new Float64Array(n);
        var rfIm = new Float64Array(n);
        var rfAmp = new Float64Array(n);
        var rfPhase = new Float64Array(n);
        var gx = new Float64Array(n);
        var gy = new Float64Array(n);
        var gz = new Float64Array(n);
        var adc = new Float64Array(n);

        var bIdx = 0;
        for (var k = 0; k < n; k++) {
            var tk = k * dt;
            t[k] = tk;
            if (tk > duration) continue;
            while (bIdx < this.blocks.length - 1 &&
                tk >= blockStarts[bIdx] + this.blockDurationUs(this.blocks[bIdx]) * 1e-6) {
                bIdx++;
            }
            var block = this.blocks[bIdx];
            var tRel = tk - blockStarts[bIdx];
            if (block.rf) {
                var rf = this._evalRf(this.rf[block.rf], tRel);
                rfRe[k] = rf.re;
                rfIm[k] = rf.im;
                rfAmp[k] = rf.amp;
                rfPhase[k] = rf.phase;
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

        return {
            dt: dt,
            duration: duration,
            n: n,
            t: t,
            rfRe: rfRe,
            rfIm: rfIm,
            rfAmp: rfAmp,
            rfPhase: rfPhase,
            gx: gx,
            gy: gy,
            gz: gz,
            adc: adc
        };
    };

    function downsampleWaveforms(wf, maxPoints) {
        maxPoints = maxPoints || 6000;
        if (wf.n <= maxPoints) return wf;
        var step = Math.ceil(wf.n / maxPoints);
        var n = Math.ceil(wf.n / step);
        function pick(src) {
            var out = new Float64Array(n);
            for (var i = 0; i < n; i++) out[i] = src[Math.min(i * step, src.length - 1)];
            return out;
        }
        return {
            dt: wf.dt * step,
            duration: wf.duration,
            n: n,
            t: pick(wf.t),
            rfRe: pick(wf.rfRe),
            rfIm: pick(wf.rfIm),
            rfAmp: pick(wf.rfAmp),
            rfPhase: pick(wf.rfPhase),
            gx: pick(wf.gx),
            gy: pick(wf.gy),
            gz: pick(wf.gz),
            adc: pick(wf.adc)
        };
    }

    function sampleAt(wf, time) {
        if (!wf || wf.n < 2) {
            return { rfAmp: 0, rfPhase: 0, gx: 0, gy: 0, gz: 0, adc: 0 };
        }
        if (time <= 0) time = 0;
        if (time >= wf.duration) {
            return { rfAmp: 0, rfPhase: 0, gx: 0, gy: 0, gz: 0, adc: 0, done: true };
        }
        var idx = time / wf.dt;
        var i0 = Math.min(wf.n - 2, Math.max(0, Math.floor(idx)));
        var f = idx - i0;
        function lerp(arr) { return arr[i0] * (1 - f) + arr[i0 + 1] * f; }
        return {
            rfAmp: lerp(wf.rfAmp),
            rfPhase: lerp(wf.rfPhase),
            gx: lerp(wf.gx),
            gy: lerp(wf.gy),
            gz: lerp(wf.gz),
            adc: wf.adc[i0],
            done: false
        };
    }

    function parse(text) {
        return new Sequence(text);
    }

    return {
        parse: parse,
        Sequence: Sequence,
        downsampleWaveforms: downsampleWaveforms,
        sampleAt: sampleAt,
        decompressShape: decompressShape
    };
});
