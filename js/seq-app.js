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
const SPEED_MAX = 5;
const SPEED_SLIDER_STEPS = 1000;

var plotHost = {};
var loaded = {
    name: "",
    seq: null,
    waveforms: null,
    summary: null,
    hasGradients: false,
    gradFactor: 1,
    sampling: null
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
    var scaled = loaded.gradFactor < 1
        ? "  ·  gradients ×" + loaded.gradFactor.toPrecision(2) + " to keep dephasing readable"
        : "";
    var undersampled = loaded.sampling && loaded.sampling.undersampled
        ? "  ·  gradient waveform under-sampled in the file (turns over every " +
            loaded.sampling.rasters.toFixed(1) + " raster steps), smoothed to keep k-space"
        : "";
    return sum.name + "  v" + sum.version +
        "  ·  " + sum.nBlocks + " blocks  ·  " + sum.nRf + " RF  ·  " + sum.nAdc + " ADC  ·  " +
        (sum.duration * 1000).toFixed(1) + " ms" +
        (flips ? "  ·  flips " + flips : "") + scaled + undersampled;
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
    // A waveform written below its own Nyquist zig-zags rather than tracing a path, which
    // reads as noise in the plot and throws the spins about. Averaging over one
    // oscillation keeps the k-space trajectory and drops what the raster could not hold.
    loaded.sampling = Pulseq.gradientSampling(waveforms, seq.rasters.grad);
    if (loaded.sampling.undersampled) {
        Pulseq.smoothGradients(waveforms,
            loaded.sampling.period * Pulseq.UNDERSAMPLED_SMOOTH_WINDOWS,
            Pulseq.UNDERSAMPLED_SMOOTH_PASSES);
    }
    loaded.gradFactor = Pulseq.gradientDisplayFactor(waveforms);
    player.stretch = autoStretch(waveforms.duration);
    setStatus(formatSummary(summary));
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

    $("pulseqToggle").addEventListener("click", function () {
        $("pulseqPanel").classList.toggle("collapsed");
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
