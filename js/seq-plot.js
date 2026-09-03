/**
 * Sequence waveform plot: ChartGPU stacked panels (anyfield seq.plot style)
 * with a 2D canvas fallback when WebGPU is unavailable.
 *
 * ChartGPU CDN and dark theme match
 * https://github.com/mrx-org/anyfield/blob/main/pypulseq/seq_plot.js
 */
export const CHARTGPU_MODULE_URL = "https://esm.sh/chartgpu@0.3.2?target=es2022";
export const LAB_SHELL_BG = "#0f1424";

/**
 * Points per row handed to the chart, as min/max pairs (see envelopeSeries), so this is
 * half as many time bins. Well above the pixel width of the panel.
 */
const PLOT_MAX_POINTS = 20000;

/**
 * Plot area insets used for every row, so the playhead can line up with the x axis.
 * The left one only has to hold the row name turned on its side, since the rows carry no
 * y tick labels: this is a qualitative view of the shape of the sequence, and in a row
 * 50 px tall the numbers cost more width than the scale they gave was worth.
 */
const GRID_LEFT = 20;
const GRID_RIGHT = 8;

const COLORS = {
    rf: "#ffe000", // matches the yellow B1 arrow in the 3D view
    rfPhase: "#ff7a18",
    gx: "#4ea1ff",
    gy: "#3dd68c",
    gz: "#b48cff",
    adc: "#ff3b30"
};

function isWebGpuAvailable() {
    return typeof navigator !== "undefined" && !!navigator.gpu;
}

function seriesXY(x, y) {
    return { x: x, y: y };
}


/** Magnitude and wrapped phase of the complex RF, as pypulseq's seq.plot shows them. */
function rfMagnitudeAndPhase(wf) {
    var mag = new Float64Array(wf.n);
    var phase = new Float64Array(wf.n);
    for (var i = 0; i < wf.n; i++) {
        var re = wf.rfRe[i];
        var im = wf.rfIm[i];
        mag[i] = Math.sqrt(re * re + im * im);
        phase[i] = mag[i] > 0 ? Math.atan2(im, re) : 0;
    }
    return { mag: mag, phase: phase };
}

function panel(title, name, color, series) {
    return { title: title, series: [{ type: "line", name: name, color: color, data: seriesXY(series.x, series.y) }] };
}

export function buildPlotPanels(wf) {
    var dtMs = wf.dt * 1000;
    var rf = rfMagnitudeAndPhase(wf);
    function row(y) { return Pulseq.envelopeSeries(y, wf.n, dtMs, PLOT_MAX_POINTS); }
    return {
        timeUnit: "ms",
        durationMs: wf.duration * 1000,
        panels: [
            panel("RF", "|RF|", COLORS.rf, row(rf.mag)),
            panel("RF phase", "RF phase", COLORS.rfPhase, row(rf.phase)),
            panel("GX", "GX", COLORS.gx, row(wf.gx)),
            panel("GY", "GY", COLORS.gy, row(wf.gy)),
            panel("GZ", "GZ", COLORS.gz, row(wf.gz)),
            panel("ADC", "ADC", COLORS.adc, row(wf.adc))
        ]
    };
}

function disposeCharts(host) {
    if (!host || !host.charts) return;
    for (var i = 0; i < host.charts.length; i++) {
        try { host.charts[i].dispose(); } catch (e) { /* ignore */ }
    }
    host.charts = [];
}

/** Suppresses every tick label on an axis (ChartGPU drops a tick whose label is null). */
function noTickLabels() {
    return null;
}

function seqChartGpuLabTheme(preset, fontSize) {
    var base = preset && typeof preset === "object" ? preset : {};
    return Object.assign({}, base, {
        backgroundColor: LAB_SHELL_BG,
        gridLineColor: "rgba(255, 255, 255, 0.08)",
        axisLineColor: "rgba(255, 255, 255, 0.1)",
        axisTickColor: "rgba(255, 255, 255, 0.1)",
        fontSize: fontSize || 10
    });
}

export async function renderSeqPlot(container, wf, host) {
    host = host || {};
    disposeCharts(host);
    container.innerHTML = "";
    var payload = buildPlotPanels(wf);
    host.durationMs = payload.durationMs;

    var stack = document.createElement("div");
    stack.id = "seq-chartgpu-stack";
    stack.className = "seq-chartgpu-stack";
    container.appendChild(stack);

    var playhead = document.createElement("div");
    playhead.className = "seq-playhead";
    playhead.style.display = "none";
    stack.appendChild(playhead);
    host.playhead = playhead;

    if (isWebGpuAvailable()) {
        try {
            await renderChartGpu(stack, payload, host);
            host.mode = "chartgpu";
            host.plotInset = { left: GRID_LEFT, right: GRID_RIGHT };
            return host;
        } catch (err) {
            console.warn("ChartGPU plot failed, using canvas fallback:", err);
            stack.innerHTML = "";
            stack.appendChild(playhead);
        }
    }
    renderCanvasFallback(stack, payload, host);
    host.mode = "canvas";
    host.plotInset = { left: 0, right: 0 };
    return host;
}

async function renderChartGpu(stack, payload, host) {
    var mod = await import(/* @vite-ignore */ CHARTGPU_MODULE_URL);
    var ChartGPU = mod.ChartGPU;
    var createPipelineCache = mod.createPipelineCache;
    var connectCharts = mod.connectCharts;
    var darkTheme = mod.darkTheme;
    if (!ChartGPU || typeof ChartGPU.create !== "function") {
        throw new Error("ChartGPU module missing create()");
    }
    var adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No WebGPU adapter");
    var device = await adapter.requestDevice();
    var pipelineCache = typeof createPipelineCache === "function" ? createPipelineCache(device) : undefined;
    var ctx = pipelineCache ? { adapter: adapter, device: device, pipelineCache: pipelineCache } : { adapter: adapter, device: device };
    var theme = seqChartGpuLabTheme(darkTheme, 10);

    var hosts = [];
    var promises = [];
    for (var i = 0; i < payload.panels.length; i++) {
        var panel = payload.panels[i];
        var h = document.createElement("div");
        h.className = "seq-chartgpu-panel";
        stack.appendChild(h);
        hosts.push(h);
        var isBottom = i === payload.panels.length - 1;
        var series = panel.series.map(function (s) {
            return {
                type: "line",
                name: s.name,
                data: s.data,
                color: s.color,
                lineStyle: { color: s.color, width: 1.4 }
            };
        });
        promises.push(ChartGPU.create(h, {
            theme: theme,
            animation: false,
            legend: { show: false },
            grid: isBottom
                ? { left: GRID_LEFT, right: GRID_RIGHT, top: 4, bottom: 22 }
                : { left: GRID_LEFT, right: GRID_RIGHT, top: 4, bottom: 4 },
            gridLines: { vertical: { count: 5 } },
            xAxis: isBottom
                ? { name: "t (ms)" }
                : { tickFormatter: noTickLabels, tickLength: 0 },
            // The name stays as the only way to tell one row from another; ChartGPU draws
            // it turned on its side just inside the grid once no tick labels push it out.
            yAxis: { name: panel.title, tickFormatter: noTickLabels, tickLength: 0 },
            // No dataZoom: the whole sequence is shown at once, with no wheel zoom
            // and no slider under the bottom row.
            dataZoom: [],
            series: series
        }, ctx));
    }
    var charts = await Promise.all(promises);
    if (typeof connectCharts === "function") {
        try { connectCharts(charts); } catch (e) { /* optional */ }
    }
    host.charts = charts;
    host.device = device;
    host.adapter = adapter;
}

function renderCanvasFallback(stack, payload, host) {
    var note = document.createElement("div");
    note.className = "seq-chartgpu-fallback";
    note.textContent = "ChartGPU / WebGPU not available — canvas seq.plot";
    stack.appendChild(note);
    var canvases = [];
    for (var i = 0; i < payload.panels.length; i++) {
        var wrap = document.createElement("div");
        wrap.className = "seq-chartgpu-panel seq-canvas-panel";
        var label = document.createElement("div");
        label.className = "seq-canvas-label";
        label.textContent = payload.panels[i].title;
        var c = document.createElement("canvas");
        wrap.appendChild(label);
        wrap.appendChild(c);
        stack.appendChild(wrap);
        canvases.push({ canvas: c, panel: payload.panels[i] });
    }
    function paint() {
        for (var p = 0; p < canvases.length; p++) {
            drawPanelCanvas(canvases[p].canvas, canvases[p].panel, payload.durationMs);
        }
    }
    paint();
    host.repaint = paint;
    host.charts = [];
}

function drawPanelCanvas(canvas, panel, durationMs) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || 320;
    var h = canvas.clientHeight || 52;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = LAB_SHELL_BG;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    var yMin = 0, yMax = 0;
    panel.series.forEach(function (s) {
        var y = s.data.y;
        for (var i = 0; i < y.length; i++) {
            if (y[i] < yMin) yMin = y[i];
            if (y[i] > yMax) yMax = y[i];
        }
    });
    if (yMax === yMin) { yMax += 1; yMin -= 1; }
    var pad = (yMax - yMin) * 0.12;
    yMin -= pad; yMax += pad;

    panel.series.forEach(function (s) {
        var x = s.data.x, y = s.data.y;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (var i = 0; i < y.length; i++) {
            var px = durationMs > 0 ? (x[i] / durationMs) * w : 0;
            var py = h - ((y[i] - yMin) / (yMax - yMin)) * h;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.stroke();
    });
}

export function setPlayhead(host, seqTimeS) {
    if (!host || !host.playhead || !host.durationMs) return;
    var frac = Math.max(0, Math.min(1, (seqTimeS * 1000) / host.durationMs));
    var inset = host.plotInset || { left: 0, right: 0 };
    // The chart reserves a left margin for the y-axis labels, so the time axis starts
    // there rather than at the edge of the panel.
    host.playhead.style.display = "block";
    host.playhead.style.left = "calc(" + inset.left + "px + " + frac +
        " * (100% - " + (inset.left + inset.right) + "px))";
}

export function hidePlayhead(host) {
    if (host && host.playhead) host.playhead.style.display = "none";
}

export function disposeSeqPlot(host) {
    disposeCharts(host);
    hidePlayhead(host);
}
