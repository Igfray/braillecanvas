#!/usr/bin/env node
/**
 * A live server monitor, drawn on real /proc data.
 *
 * Shows the three things braillecanvas does that a plain dot canvas doesn't:
 *   · WEIGHT — the grid is drawn at weight 0, the traces at 2 and 3, so a gridline crossing
 *     a trace never steals its colour. Draw order stops mattering.
 *   · tryText — labels are REFUSED rather than clipped or overwritten, so a crowded chart
 *     silently drops a label instead of rendering a lie.
 *   · 2x4 dots per cell — this is a 156x80 framebuffer inside a 78x20 terminal.
 *
 * Usage:  node examples/monitor.js [--frames N] [--interval MS] [--no-colour]
 */
import {Canvas} from 'braillecanvas';
import {readFileSync} from 'node:fs';

const arg = (flag, dflt) => {
    const i = process.argv.indexOf(flag);
    return i === -1 ? dflt : Number(process.argv[i + 1]);
};
const FRAMES   = arg('--frames', 40);
const INTERVAL = arg('--interval', 500);
const COLOUR   = !process.argv.includes('--no-colour');

const COLS = 78, ROWS = 20;
const HIST = 68;                        // samples kept; one per 2 dot-columns

// Chart box, in DOT coordinates (2x cols, 4x rows).
const X0 = 10, X1 = COLS * 2 - 3;
const Y0 = 10, Y1 = 60;

const INK = {
    grid:  0x2c3038,
    cpu:   0xff8c42,
    mem:   0x3987e5,
    load:  0x9b6dff,
    label: 0x8b93a1,
    title: 0xe8eaed,
    warn:  0xff4d4d,
};

/** Total and idle jiffies from /proc/stat's aggregate line. */
function cpuTotals() {
    const f = readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
    const idle = f[3] + f[4];                       // idle + iowait
    return {total: f.reduce((a, b) => a + b, 0), idle};
}

function memPercent() {
    const m = Object.fromEntries(
        readFileSync('/proc/meminfo', 'utf8').split('\n').filter(Boolean).map(l => {
            const [k, v] = l.split(':');
            return [k, parseInt(v, 10)];
        }));
    // "available" is the honest number — free(1)'s own advice, and what you act on.
    return {pct: 100 * (1 - m.MemAvailable / m.MemTotal), gib: (m.MemTotal - m.MemAvailable) / 1048576};
}

const loadAvg = () => Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);

const cpuHist = [], memHist = [], loadHist = [];
let prev = cpuTotals();

/** Map a percentage to a dot row inside the chart box. */
const yOf = pct => Math.round(Y1 - (Math.max(0, Math.min(100, pct)) / 100) * (Y1 - Y0));

function trace(series, rgb, weight) {
    if (series.length < 2) return;
    const step = (X1 - X0) / (HIST - 1);
    for (let i = 1; i < series.length; i++) {
        const xa = Math.round(X0 + (i - 1 + HIST - series.length) * step);
        const xb = Math.round(X0 + (i     + HIST - series.length) * step);
        c.line(xa, yOf(series[i - 1]), xb, yOf(series[i]), rgb, weight);
    }
}

const c = new Canvas(COLS, ROWS);

function draw(cpu, mem, load, cores) {
    c.clear();

    // Grid FIRST and lightest — weight 0 means it can never win a cell from a trace.
    for (const pct of [0, 25, 50, 75, 100])
        c.dottedLine(X0, yOf(pct), X1, yOf(pct), INK.grid, 0, 3);
    c.line(X0, Y0, X0, Y1, INK.grid, 0);

    trace(memHist,  INK.mem,  2);
    trace(loadHist, INK.load, 2);
    trace(cpuHist,  INK.cpu,  3);          // heaviest: CPU owns any cell it shares

    // Axis labels: cell coords. Rows are dot-rows / 4.
    for (const pct of [0, 50, 100])
        c.tryText(0, Math.round(yOf(pct) / 4), String(pct).padStart(3) + '%', INK.label);

    c.text(0, 0, 'legionnaire', INK.title);
    c.tryText(14, 0, `cpu ${cpu.toFixed(0).padStart(3)}%`, INK.cpu);
    c.tryText(26, 0, `mem ${mem.pct.toFixed(0).padStart(3)}% (${mem.gib.toFixed(1)}GiB)`, INK.mem);
    c.tryText(48, 0, `load ${load.toFixed(2)}`, load > cores ? INK.warn : INK.load);
    c.tryText(62, 0, `${HIST * INTERVAL / 1000 | 0}s window`, INK.label);

    // Per-core strip along the bottom, one bar per core.
    // The label goes FIRST: tryText refuses to overwrite an existing GLYPH, but bars are dots,
    // not glyphs — so a label written after the bars would sit on top of them (it did). Drawing
    // the label first means the bars flow around it and the refusal logic never has to fire.
    c.tryText(0, ROWS - 1, `${cores.length} cores`, INK.label);
    const barTop = ROWS * 4 - 6, barBot = ROWS * 4 - 1;
    const LEFT = 16;                       // clear of the label, in dot columns
    const w = Math.max(1, Math.floor((COLS * 2 - LEFT - 2) / cores.length));
    cores.forEach((pct, i) => {
        const x = LEFT + i * w;
        const top = Math.round(barBot - (pct / 100) * (barBot - barTop));
        for (let dx = 0; dx < w - 2; dx++) {
            c.line(x + dx, barBot, x + dx, top, pct > 80 ? INK.warn : INK.cpu, 2);
            c.set(x + dx, barBot, INK.grid, 1);
        }
    });

    return c.toString({colour: COLOUR, background: COLOUR ? 0x0d1117 : null});
}

/** Per-core busy% between two /proc/stat reads. */
let prevCores = coreLines();
function coreLines() {
    return readFileSync('/proc/stat', 'utf8').split('\n')
        .filter(l => /^cpu\d+/.test(l))
        .map(l => {
            const f = l.split(/\s+/).slice(1).map(Number);
            return {total: f.reduce((a, b) => a + b, 0), idle: f[3] + f[4]};
        });
}

let frame = 0;
const timer = setInterval(() => {
    const now = cpuTotals();
    const dTotal = now.total - prev.total, dIdle = now.idle - prev.idle;
    const cpu = dTotal > 0 ? 100 * (1 - dIdle / dTotal) : 0;
    prev = now;

    const nowCores = coreLines();
    const cores = nowCores.map((cur, i) => {
        const dt = cur.total - prevCores[i].total, di = cur.idle - prevCores[i].idle;
        return dt > 0 ? 100 * (1 - di / dt) : 0;
    });
    prevCores = nowCores;

    const mem = memPercent(), load = loadAvg();
    for (const [h, v] of [[cpuHist, cpu], [memHist, mem.pct], [loadHist, 100 * load / cores.length]]) {
        h.push(v);
        if (h.length > HIST) h.shift();
    }

    // Redraw in place: home the cursor rather than scrolling, so the chart sits still.
    process.stdout.write('\x1b[H' + draw(cpu, mem, load, cores));

    if (++frame >= FRAMES) {
        clearInterval(timer);
        process.stdout.write('\x1b[?25h\n');
    }
}, INTERVAL);

process.stdout.write('\x1b[2J\x1b[?25l');           // clear, hide cursor
process.on('SIGINT', () => { process.stdout.write('\x1b[?25h\n'); process.exit(0); });
