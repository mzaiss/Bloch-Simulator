/**
 * Pulseq UI: load .seq → ChartGPU seq.plot → Play into the Bloch simulator.
 */
import {
    renderSeqPlot,
    setPlayhead,
    hidePlayhead
} from "./seq-plot.js";

const EXAMPLES = [
    { name: "Choose example…", path: "" },
    { name: "FID (variable flip)", path: "seq/web1_FID.seq" },
    { name: "Spin echo (CPMG)", path: "seq/web2_SpinEcho_me.seq" },
    { name: "Spin echo (non-CPMG)", path: "seq/web2_SpinEcho_nonCPMG.seq" },
    { name: "Spin echo (sinc)", path: "seq/web2_SpinEcho_sinc.seq" },
    { name: "FLASH 16", path: "seq/web3_FLASH_16.seq" },
    { name: "RARE 16", path: "seq/web4_RARE_16.seq" },
    { name: "EPI 16", path: "seq/web5_EPI_16.seq" },
    { name: "Spiral TSE", path: "seq/spiral_tse_ss.seq" }
];

const TARGET_PLAY_S = 8;
const MIN_STRETCH = 10;
const MAX_STRETCH = 400;
/** Largest Bloch rotation per sub-step while RF is on, where B1 and B0 do not commute. */
const MAX_SUBSTEP_ANGLE = 0.05;
/** Isochromat updates per frame the sub-stepping may spend (Plane is 441 spins). */
const SUBSTEP_BUDGET = 8000;
const SUBSTEP_LIMIT = 128;
/** RF counts as on above this fraction of the sequence peak (sinc zero crossings). */
const RF_ON_FRACTION = 1e-3;
/** Speed slider: logarithmic, so the slow end where gradients are readable is usable. */
const SPEED_MIN = 0.002;
const SPEED_MAX = 20;
const SPEED_SLIDER_STEPS = 1000;

var plotHost = {};
var loaded = {
    name: "",
    seq: null,
    waveforms: null,
    summary: null,
    hasGradients: false,
    gradFactor: 1,
    targetK: 0
};
var player = {
    playing: false,
    t: 0,
    stretch: 80,
    speed: 1,
    rfWasOn: false,
    guiAge: 0,
    rfOnThreshold: 0,
    maxRadius: 0
};

function gradScaleOf() {
    var bridge = window.BlochSimBridge;
    return (bridge && bridge.gradScale) || 11;
}

function peakRf(wf) {
    var peak = 0;
    for (var i = 0; i < wf.n; i++) {
        var amp = Math.sqrt(wf.rfRe[i] * wf.rfRe[i] + wf.rfIm[i] * wf.rfIm[i]);
        if (amp > peak) peak = amp;
    }
    return peak;
}

function maxIsocRadius(state) {
    var arr = (state && state.IsocArr) || [];
    var max = 0;
    for (var i = 0; i < arr.length; i++) {
        var p = arr[i].pos;
        if (!p) continue;
        var d = Math.sqrt(p.x * p.x + p.y * p.y);
        if (d > max) max = d;
    }
    return max;
}

/**
 * Spacing of the closest pair of isochromats, in scene units — the sample's resolution,
 * and so what sets the finest stripe pattern a gradient can write into it. Taken from the
 * positions rather than the scene name, since the scenes differ (Plane and Line step by
 * 0.4, LineDense by 0.2) and a non-uniform sample has gaps wider than its spacing.
 */
function isocSpacing(state) {
    var arr = (state && state.IsocArr) || [];
    var min = Infinity;
    for (var i = 0; i < arr.length; i++) {
        var a = arr[i].pos;
        if (!a) continue;
        for (var j = i + 1; j < arr.length; j++) {
            var b = arr[j].pos;
            if (!b) continue;
            var d = Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
            if (d > 1e-9 && d < min) min = d;
        }
    }
    return isFinite(min) ? min : 0;
}

/** Width of the isochromat cloud, in scene units, along whichever axis it spans most. */
function isocWidth(state) {
    var arr = (state && state.IsocArr) || [];
    var lo = { x: Infinity, y: Infinity };
    var hi = { x: -Infinity, y: -Infinity };
    for (var i = 0; i < arr.length; i++) {
        var p = arr[i].pos;
        if (!p) continue;
        lo.x = Math.min(lo.x, p.x);
        hi.x = Math.max(hi.x, p.x);
        lo.y = Math.min(lo.y, p.y);
        hi.y = Math.max(hi.y, p.y);
    }
    var w = Math.max(hi.x - lo.x, hi.y - lo.y);
    return isFinite(w) && w > 0 ? w : 0;
}

/**
 * Gradient scaling for the current sample. Normalized scales the sequence's outermost ADC
 * sample to the same winding across the sample whatever field of view and matrix it was
 * written for, so the examples are comparable to each other and to the sample we have.
 * Unnormalized plays the gradients at their physical strength.
 */
function updateGradFactor() {
    if (!loaded.waveforms) return;
    var el = $("pulseqNormalize");
    var normalize = !el || el.checked;
    var state = window.BlochSimBridge && window.BlochSimBridge.getState
        ? window.BlochSimBridge.getState() : null;
    loaded.targetK = normalize
        ? Pulseq.displayTargetK(isocWidth(state), isocSpacing(state))
        : 0;
    loaded.gradFactor = Pulseq.gradientDisplayFactor(loaded.waveforms, loaded.targetK);
}

function $(id) { return document.getElementById(id); }

function setStatus(text, isError) {
    var el = $("pulseqStatus");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("error", !!isError);
}

function formatSummary(sum) {
    var flips = sum.flips.slice(0, 8).map(function (f) { return f + "°"; }).join(", ");
    if (sum.flips.length > 8) flips += ", …";
    // A sequence with no gradients under its ADC has no k-space to normalize, and keeps
    // the factor of 1 that would make the note a claim about nothing.
    var scaled = Math.abs(loaded.gradFactor - 1) > 0.005
        ? "  ·  gradients ×" + loaded.gradFactor.toPrecision(2) +
            " so the outermost ADC sample reaches " + loaded.targetK.toPrecision(3) +
            " 1/m across the sample"
        : "";
    return sum.name + "  v" + sum.version +
        "  ·  " + sum.nBlocks + " blocks  ·  " + sum.nRf + " RF  ·  " + sum.nAdc + " ADC  ·  " +
        (sum.duration * 1000).toFixed(1) + " ms" +
        (flips ? "  ·  flips " + flips : "") + scaled;
}

function sliderToSpeed(pos) {
    return SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, pos / SPEED_SLIDER_STEPS);
}

function speedToSlider(speed) {
    return Math.round(SPEED_SLIDER_STEPS *
        Math.log(speed / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN));
}

function formatSpeed(speed) {
    if (speed >= 1) return (Math.round(speed * 10) / 10) + "×";
    if (speed >= 0.1) return speed.toFixed(2) + "×";
    return speed.toFixed(3) + "×";
}

function autoStretch(duration) {
    if (!(duration > 0)) return 80;
    return Math.max(MIN_STRETCH, Math.min(MAX_STRETCH, TARGET_PLAY_S / duration));
}

async function loadSeqText(text, name) {
    stopPlayback(true);
    var seq = Pulseq.parse(text);
    var summary = seq.summary();
    var waveforms = seq.rasterize(seq.suggestedRaster());
    loaded.name = name || summary.name;
    loaded.seq = seq;
    loaded.waveforms = waveforms;
    loaded.summary = summary;
    loaded.hasGradients = false;
    for (var i = 0; i < waveforms.n && !loaded.hasGradients; i++) {
        if (Math.abs(waveforms.gx[i]) > 1 || Math.abs(waveforms.gy[i]) > 1) loaded.hasGradients = true;
    }
    updateGradFactor();
    player.stretch = autoStretch(waveforms.duration);
    // Every format revision so far has inserted columns into the event tables, so a file
    // newer than the parser reads as plausible nonsense unless it is called out.
    var warning = seq.version.newerThanParser
        ? "Pulseq v" + summary.version + " is newer than this parser, which reads up to" +
            " v1.5 — RF and gradient events may be misread.  ·  "
        : "";
    setStatus(warning + formatSummary(summary), seq.version.newerThanParser);
    $("pulseqPlay").disabled = false;
    $("pulseqPanel").classList.add("has-seq");
    $("pulseqMeta").textContent = loaded.name;
    await renderSeqPlot($("pulseqPlot"), waveforms, plotHost);
}

async function loadFromPath(path, name) {
    setStatus("Loading " + (name || path) + "…");
    var res = await fetch(path);
    if (!res.ok) throw new Error("Could not fetch " + path + " (" + res.status + ")");
    await loadSeqText(await res.text(), name || path.split("/").pop());
}

function loadFromFile(file) {
    return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
            loadSeqText(String(reader.result), file.name).then(resolve).catch(reject);
        };
        reader.onerror = function () { reject(reader.error); };
        reader.readAsText(file);
    });
}

function stopPlayback(resetTime) {
    player.playing = false;
    if (resetTime) {
        player.t = 0;
        player.rfWasOn = false;
        hidePlayhead(plotHost);
    }
    var play = $("pulseqPlay");
    if (play) play.textContent = "Play";
    var fid = $("fidbox");
    if (fid) fid.style.backgroundColor = "transparent";
    var bridge = window.BlochSimBridge;
    if (bridge && bridge.clearSeqDrive) bridge.clearSeqDrive();
}

function startPlayback() {
    if (!loaded.waveforms) return;
    var bridge = window.BlochSimBridge;
    if (bridge && bridge.prepareForSeq) bridge.prepareForSeq();
    player.t = 0;
    player.rfWasOn = false;
    player.guiAge = 0;
    player.rfOnThreshold = peakRf(loaded.waveforms) * RF_ON_FRACTION;
    player.maxRadius = maxIsocRadius(bridge && bridge.getState ? bridge.getState() : null);
    // The scene may have changed since the file was loaded, and the normalization is
    // relative to whatever sample is now in the view.
    updateGradFactor();
    player.playing = true;
    $("pulseqPlay").textContent = "Stop";
    // Gradients act through position, so they do nothing to a sample sitting at the origin.
    var noSpatialSample = loaded.hasGradients && player.maxRadius < 1e-6;
    setStatus("Playing " + loaded.name + "  (" +
        (loaded.summary.duration * 1000).toFixed(1) + " ms seq → " +
        (loaded.waveforms.duration * player.stretch / player.speed).toFixed(1) + " s view at " +
        formatSpeed(player.speed) + ")" +
        (noSpatialSample ? "  ·  pick Plane or a gradient scene to see Gx/Gy act" : ""));
}

/** Drive the simulator fields from the waveform averaged over one (sub-)step. */
function driveState(state, mean, stretch) {
    var amp = Math.sqrt(mean.rfRe * mean.rfRe + mean.rfIm * mean.rfIm);
    var rfOn = amp > player.rfOnThreshold;
    if (rfOn) {
        var phase = Math.atan2(mean.rfIm, mean.rfRe);
        var bridge = window.BlochSimBridge;
        if (!player.rfWasOn && bridge && bridge.markRfStart) bridge.markRfStart(phase);
        else state.phi1 = phase;
        state.B1 = Pulseq.rfToEdu(amp, stretch);
    } else {
        state.B1 = 0;
    }
    player.rfWasOn = rfOn;
    state.tLeftRF = 0;
    state.areaLeftRF = 0;
    state.areaLeftGrad = 0;
    var gradScale = gradScaleOf();
    state.Gx = Pulseq.gradToEdu(mean.gx, stretch, gradScale) * loaded.gradFactor;
    state.Gy = Pulseq.gradToEdu(mean.gy, stretch, gradScale) * loaded.gradFactor;
}

/**
 * Sub-steps needed this frame. Gradients alone rotate purely about z, which commutes,
 * so their averaged moment is already exact in a single step. RF does not commute with
 * the off-resonance field, so it is split until each rotation is small.
 */
function subStepCount(mean, dt, state, stretch) {
    var amp = Math.sqrt(mean.rfRe * mean.rfRe + mean.rfIm * mean.rfIm);
    if (!(amp > player.rfOnThreshold)) return 1;
    var gradScale = gradScaleOf();
    var detuning = (Math.abs(Pulseq.gradToEdu(mean.gx, stretch, gradScale)) +
        Math.abs(Pulseq.gradToEdu(mean.gy, stretch, gradScale))) * player.maxRadius / gradScale;
    var angle = (state.Gamma || 1) * (Pulseq.rfToEdu(amp, stretch) + detuning) * dt;
    var budget = Math.floor(SUBSTEP_BUDGET / Math.max(1, state.IsocArr.length));
    var allowed = Math.max(1, Math.min(SUBSTEP_LIMIT, budget));
    return Math.max(1, Math.min(Math.ceil(angle / MAX_SUBSTEP_ANGLE), allowed));
}

/**
 * Replaces the plain BlochStep(dt) call in the animate loop while a sequence plays.
 * The waveform is integrated over the frame instead of sampled once, so flip angles and
 * gradient moments come out the same whatever the frame rate or playback speed.
 */
function stepSequence(dt, state, blochStep) {
    if (!player.playing || !loaded.waveforms || !state) return blochStep(dt);

    var wf = loaded.waveforms;
    if (player.t >= wf.duration) {
        finishPlayback();
        return blochStep(dt);
    }

    var stretch = player.stretch / (player.speed || 1);
    var t0 = player.t;
    var t1 = Math.min(t0 + dt / stretch, wf.duration);
    var driveDt = (t1 - t0) * stretch;

    var frame = Pulseq.meanOver(wf, t0, t1);
    var nSteps = subStepCount(frame, driveDt, state, stretch);
    var seqStep = (t1 - t0) / nSteps;
    var wallStep = driveDt / nSteps;
    var B1vec;
    for (var i = 0; i < nSteps; i++) {
        var a = t0 + i * seqStep;
        driveState(state, Pulseq.meanOver(wf, a, a + seqStep), stretch);
        B1vec = blochStep(wallStep);
    }

    player.t = t1;
    setPlayhead(plotHost, t1);
    var fid = $("fidbox");
    if (fid) fid.style.backgroundColor = frame.adc ? "rgba(255,80,40,0.18)" : "transparent";

    player.guiAge += dt;
    if (player.guiAge > 0.25) {
        player.guiAge = 0;
        if (window.BlochSimBridge && window.BlochSimBridge.markGradientsDirty) {
            window.BlochSimBridge.markGradientsDirty();
        }
    }

    if (t1 >= wf.duration) {
        finishPlayback();
        var rest = dt - driveDt;
        if (rest > 0) B1vec = blochStep(rest);
    }
    return B1vec;
}

function finishPlayback() {
    stopPlayback(false);
    var repeat = $("pulseqRepeat");
    if (repeat && repeat.checked) {
        startPlayback();
        return;
    }
    setStatus("Finished " + loaded.name);
}

function bindUi() {
    EXAMPLES.forEach(function (ex, i) {
        var opt = document.createElement("option");
        opt.value = ex.path;
        opt.textContent = ex.name;
        if (i === 0) opt.disabled = true;
        $("pulseqExample").appendChild(opt);
    });
    $("pulseqExample").selectedIndex = 0;

    $("pulseqExample").addEventListener("change", function () {
        var path = this.value;
        if (!path) return;
        var name = this.options[this.selectedIndex].textContent;
        loadFromPath(path, name).catch(function (err) {
            setStatus(String(err.message || err), true);
        });
    });

    $("pulseqFile").addEventListener("change", function () {
        var file = this.files && this.files[0];
        if (!file) return;
        $("pulseqExample").selectedIndex = 0;
        loadFromFile(file).catch(function (err) {
            setStatus(String(err.message || err), true);
        });
    });

    $("pulseqPlay").addEventListener("click", function () {
        if (player.playing) stopPlayback(false);
        else startPlayback();
    });

    var speedSlider = $("pulseqSpeed");
    speedSlider.min = 0;
    speedSlider.max = SPEED_SLIDER_STEPS;
    speedSlider.step = 1;
    speedSlider.value = speedToSlider(player.speed);
    speedSlider.addEventListener("input", function () {
        player.speed = sliderToSpeed(parseFloat(this.value));
        $("pulseqSpeedLabel").textContent = formatSpeed(player.speed);
    });

    $("pulseqNormalize").addEventListener("change", function () {
        updateGradFactor();
        if (loaded.summary) setStatus(formatSummary(loaded.summary));
    });

    // The whole header is the target, which is what its pointer cursor has always implied
    // and what makes the narrow collapsed strip easy to get back.
    $("pulseqHead").addEventListener("click", function () {
        var collapsed = $("pulseqPanel").classList.toggle("collapsed");
        var toggle = $("pulseqToggle");
        toggle.textContent = collapsed ? "▸" : "▾";
        toggle.title = collapsed ? "Expand" : "Collapse";
    });
}

function init() {
    bindUi();
    window.pulseqStepSequence = stepSequence;
    window.PulseqApp = {
        loadSeqText: loadSeqText,
        loadFromPath: loadFromPath,
        startPlayback: startPlayback,
        stopPlayback: stopPlayback,
        player: player,
        loaded: loaded
    };
    setStatus("Load a .seq file or pick an example, then Play.");
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
