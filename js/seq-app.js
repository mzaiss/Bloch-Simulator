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
    { name: "Spin echo", path: "seq/web2_SpinEcho_me.seq" },
    { name: "Spin echo (sinc)", path: "seq/web2_SpinEcho_sinc.seq" },
    { name: "FLASH 16", path: "seq/web3_FLASH_16.seq" },
    { name: "RARE 16", path: "seq/web4_RARE_16.seq" },
    { name: "EPI 16", path: "seq/web5_EPI_16.seq" }
];

const TARGET_PLAY_S = 8;
const MIN_STRETCH = 10;
const MAX_STRETCH = 400;
const GRAD_VIS = 0.012;

var plotHost = {};
var loaded = {
    name: "",
    seq: null,
    waveforms: null,
    summary: null
};
var player = {
    playing: false,
    t: 0,
    stretch: 80,
    speed: 1,
    rfWasOn: false
};

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
    return sum.name + "  v" + sum.version +
        "  ·  " + sum.nBlocks + " blocks  ·  " + sum.nRf + " RF  ·  " + sum.nAdc + " ADC  ·  " +
        (sum.duration * 1000).toFixed(1) + " ms" +
        (flips ? "  ·  flips " + flips : "");
}

function autoStretch(duration) {
    if (!(duration > 0)) return 80;
    return Math.max(MIN_STRETCH, Math.min(MAX_STRETCH, TARGET_PLAY_S / duration));
}

async function loadSeqText(text, name) {
    stopPlayback(true);
    var seq = Pulseq.parse(text);
    var summary = seq.summary();
    var waveforms = seq.rasterize(summary.duration > 0.4 ? 50e-6 : 20e-6);
    loaded.name = name || summary.name;
    loaded.seq = seq;
    loaded.waveforms = waveforms;
    loaded.summary = summary;
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
    player.playing = true;
    $("pulseqPlay").textContent = "Stop";
    setStatus("Playing " + loaded.name + "  (" +
        (loaded.summary.duration * 1000).toFixed(1) + " ms seq → " +
        (loaded.waveforms.duration * player.stretch / player.speed).toFixed(1) + " s view)");
}

/**
 * Called from the Bloch animate loop. Maps Pulseq waveforms onto educational
 * Bloch units so flip angles stay physically correct under time-stretch.
 */
function applyTick(dt, state) {
    if (!player.playing || !loaded.waveforms || !state) return;
    var stretch = player.stretch / (player.speed || 1);
    player.t += dt / stretch;
    var s = Pulseq.sampleAt(loaded.waveforms, player.t);
    setPlayhead(plotHost, player.t);

    if (s.done) {
        stopPlayback(false);
        setStatus("Finished " + loaded.name);
        state.B1 = 0;
        state.Gx = 0;
        state.Gy = 0;
        state.tLeftRF = 0;
        state.areaLeftRF = 0;
        state.areaLeftGrad = 0;
        return;
    }

    var rfOn = Math.abs(s.rfAmp) > 1e-6;
    if (rfOn && !player.rfWasOn) {
        state.tSinceRF = 0;
        if (typeof window.BlochSimBridge === "object" && window.BlochSimBridge.markRfStart) {
            window.BlochSimBridge.markRfStart(s.rfPhase);
        } else {
            state.phi1 = s.rfPhase;
        }
    }
    player.rfWasOn = rfOn;

    // gamma_edu * B1_edu * dt_wall = 2π * B1_Hz * dt_phys, dt_phys = dt_wall / stretch
    state.B1 = rfOn ? (2 * Math.PI * s.rfAmp) / stretch : 0;
    state.tLeftRF = 0;
    state.areaLeftRF = 0;
    state.areaLeftGrad = 0;
    state.Gx = (s.gx * GRAD_VIS) / stretch;
    state.Gy = (s.gy * GRAD_VIS) / stretch;

    var fid = $("fidbox");
    if (fid) fid.style.backgroundColor = s.adc ? "rgba(255,80,40,0.18)" : "transparent";
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

    $("pulseqSpeed").addEventListener("input", function () {
        player.speed = parseFloat(this.value) || 1;
        $("pulseqSpeedLabel").textContent = player.speed.toFixed(2).replace(/\.?0+$/, "") + "×";
    });

    $("pulseqToggle").addEventListener("click", function () {
        $("pulseqPanel").classList.toggle("collapsed");
    });
}

function init() {
    bindUi();
    window.pulseqApplyTick = applyTick;
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
