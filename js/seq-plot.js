/**
 * Sequence waveform plot: ChartGPU stacked panels (anyfield seq.plot style)
 * with a 2D canvas fallback when WebGPU is unavailable.
 *
 * ChartGPU CDN and dark theme match
 * https://github.com/mrx-org/anyfield/blob/main/pypulseq/seq_plot.js
 */
export const CHARTGPU_MODULE_URL = "https://esm.sh/chartgpu@0.3.2?target=es2022";
export const LAB_SHELL_BG = "#0f1424";

const COLORS = {
    rfRe: "#4ea1ff",
    rfIm: "#7ee0ff",
    gx: "#ff5c5c",
    gy: "#3dd68c",
    gz: "#f0c14a",
    adc: "#ff7a18"
};

function isWebGpuAvailable() {
    return typeof navigator !== "undefined" && !!navigator.gpu;
}

function seriesXY(x, y) {
    return { x: x, y: y };
}

function downsampleForPlot(wf, maxPoints) {
    if (typeof Pulseq !== "undefined" && Pulseq.downsampleWaveforms) {
        return Pulseq.downsampleWaveforms(wf, maxPoints);
    }
    return wf;
}

function msAxis(wf) {
    var t = new Float64Array(wf.n);
    for (var i = 0; i < wf.n; i++) t[i] = wf.t[i] * 1000;
    return t;
}

export function buildPlotPanels(wf) {
    var plot = downsampleForPlot(wf, 5000);
    var tMs = msAxis(plot);
    return {
        timeUnit: "ms",
        durationMs: plot.duration * 1000,
        panels: [
            { title: "RF (Hz)", series: [
                { type: "line", name: "Re", color: COLORS.rfRe, data: seriesXY(tMs, plot.rfRe) },
                { type: "line", name: "Im", color: COLORS.rfIm, data: seriesXY(tMs, plot.rfIm) }
            ]},
            { title: "GX (Hz/m)", series: [{ type: "line", name: "GX", color: COLORS.gx, data: seriesXY(tMs, plot.gx) }] },
            { title: "GY (Hz/m)", series: [{ type: "line", name: "GY", color: COLORS.gy, data: seriesXY(tMs, plot.gy) }] },
            { title: "GZ (Hz/m)", series: [{ type: "line", name: "GZ", color: COLORS.gz, data: seriesXY(tMs, plot.gz) }] },
            { title: "ADC", series: [{ type: "line", name: "ADC", color: COLORS.adc, data: seriesXY(tMs, plot.adc) }] }
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
            return host;
        } catch (err) {
            console.warn("ChartGPU plot failed, using canvas fallback:", err);
            stack.innerHTML = "";
            stack.appendChild(playhead);
        }
    }
    renderCanvasFallback(stack, payload, host);
    host.mode = "canvas";
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
                ? { left: 54, right: 8, top: 4, bottom: 22 }
                : { left: 54, right: 8, top: 4, bottom: 4 },
            gridLines: { vertical: { count: 5 } },
            xAxis: isBottom
                ? { name: "t (ms)" }
                : { tickFormatter: function () { return null; }, tickLength: 0 },
            yAxis: { name: panel.title },
            dataZoom: isBottom
                ? [{ type: "inside", minSpan: 0.008 }, { type: "slider", minSpan: 0.008, height: 8 }]
                : [{ type: "inside", minSpan: 0.008 }],
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
    var pct = Math.max(0, Math.min(1, (seqTimeS * 1000) / host.durationMs));
    host.playhead.style.display = "block";
    host.playhead.style.left = (pct * 100) + "%";
}

export function hidePlayhead(host) {
    if (host && host.playhead) host.playhead.style.display = "none";
}

export function disposeSeqPlot(host) {
    disposeCharts(host);
    hidePlayhead(host);
}
