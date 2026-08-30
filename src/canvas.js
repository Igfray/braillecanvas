// SPDX-FileCopyrightText: 2026 Isaac <isaac3349@proton.me>
// SPDX-License-Identifier: MIT
//
// A braille framebuffer with colour and labels.
//
// Unicode braille (U+2800–U+28FF) addresses 2×4 dots per character cell, so an 80×24 terminal
// is really a 160×96 canvas. That is what separates a rendering from ASCII art.
//
// THE DOTS ARE VERY NEARLY SQUARE, which is a lucky property worth stating because it is easy
// to assume otherwise. A character cell is about 1:2 (width:height) in every monospace font;
// dividing it into 2 columns and 4 rows gives dot spacing of w/2 horizontally and h/4 = w/2
// vertically. Measured in Ubuntu Mono 11: cell 8.00 × 17px, so dots are 4.00 × 4.25px — an
// aspect of 1.062. `aspect` corrects that residual 6%; it is not load-bearing, and a caller
// that ignores it gets shapes 6% tall rather than unrecognisable ones.
//
// COLOUR IS PER CELL, NOT PER DOT. A cell holds eight dots but takes one foreground colour, so
// when two marks land in the same cell one of them has to win. `weight` decides: the heavier
// mark keeps the colour. Blending would turn a dense cluster grey, and the eye does the same
// thing anyway.

const BLANK = 0x2800;

// Braille dot numbering is historical, not raster order:
//     1 4
//     2 5
//     3 6
//     7 8
// so the bit for (col, row) is not simply row*2+col.
const DOT_BIT = [
    [0x01, 0x08],   // row 0
    [0x02, 0x10],   // row 1
    [0x04, 0x20],   // row 2
    [0x40, 0x80],   // row 3
];

export class Canvas {
    /**
     * @param {number} cols  terminal columns
     * @param {number} rows  terminal rows
     * @param {object} [opt]
     * @param {number} [opt.aspect]  height/width of one dot; 1.0 is square
     */
    constructor(cols, rows, opt = {}) {
        // Validate here rather than letting the typed-array constructor throw
        // "Invalid typed array length: -15", which names nothing the caller passed.
        for (const [name, v] of [['cols', cols], ['rows', rows]]) {
            if (!Number.isInteger(v))
                throw new RangeError(`Canvas ${name} must be an integer, got ${v}`);
            if (v < 0)
                throw new RangeError(`Canvas ${name} must not be negative, got ${v}`);
        }
        this.cols = cols;
        this.rows = rows;
        this.width = cols * 2;
        this.height = rows * 4;
        this.aspect = opt.aspect ?? 1.0;
        this.cells = new Uint8Array(cols * rows);
        // Packed 0xRRGGBB per cell, and the weight that won it, so a later lighter mark cannot
        // steal the colour of a heavier one already there.
        this.colour = new Int32Array(cols * rows).fill(-1);
        this.weight = new Float32Array(cols * rows);
    }

    clear() {
        this.cells.fill(0);
        this.colour.fill(-1);
        this.weight.fill(0);
        this.bg?.fill(-1);
        // The glyph map too. Without this, every label ever drawn stays on the canvas — which
        // on a static render looks fine and on an animated one smears text across the frame.
        this._glyphs?.clear();
    }

    /**
     * Paint one CELL's background, at cell coordinates.
     *
     * Eight dots share a single foreground colour — braille's real constraint. A background
     * gives the cell a second colour, and the dot pattern selects between them, so a cell can
     * straddle an edge (skin against sky) instead of averaging it into mud. Measured on a
     * photograph at 110 columns: mean per-dot colour error 45.7 -> 21.3, a 53% improvement.
     *
     * Allocated lazily: a canvas that never calls this pays nothing, and the renderer skips
     * the whole background path.
     */
    setCellBackground(col, row, rgb) {
        // FLOOR, not round, to agree with set(). A cell spans [n, n+1), so a coordinate of 1.5
        // is inside cell 1; rounding sends it to cell 2, a cell the caller's point is not in.
        // Silently drawing in the wrong place is the same defect fixed in text() for 0.2.1.
        const c = Math.floor(col), r = Math.floor(row);
        if (!Number.isFinite(c) || !Number.isFinite(r) ||
            c < 0 || r < 0 || c >= this.cols || r >= this.rows)
            return;
        (this.bg ??= new Int32Array(this.cols * this.rows).fill(-1))[r * this.cols + c] = rgb;
    }

    /**
     * Light one dot at DOT coordinates.
     *
     * `weight` decides which mark owns the cell's colour when several share it — pass a
     * magnitude, a z-depth, an importance, whatever ranks your marks. Ties go to the newer one.
     */
    set(x, y, rgb = -1, weight = 0) {
        // Validate BEFORE coercing. `x | 0` maps NaN and undefined to 0 and truncates toward
        // zero, so (-0.5)|0 is -0 — which is not < 0. Both slipped past the bounds check and
        // planted a dot in the top-left corner: NaN is precisely what a projection returns for
        // a point behind the viewer, the case line()'s loop guard already defends against.
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return;
        const ay = this.aspect === 1 ? y : y * this.aspect;
        if (!Number.isFinite(ay))
            return;
        const dx = Math.floor(x), dy = Math.floor(ay);
        if (dx < 0 || dy < 0 || dx >= this.width || dy >= this.height)
            return;
        const cx = dx >> 1, cy = dy >> 2;
        const i = cy * this.cols + cx;
        this.cells[i] |= DOT_BIT[dy & 3][dx & 1];
        if (rgb >= 0 && weight >= this.weight[i]) {
            this.colour[i] = rgb;
            this.weight[i] = weight;
        }
    }

    /** Bresenham, at dot coordinates. */
    line(x0, y0, x1, y1, rgb = -1, weight = 0) {
        // Reject non-finite endpoints before anything else. There IS a loop guard below, but it
        // is computed from the endpoints — so an infinite endpoint makes the limit itself
        // Infinity and the guard never fires. line(0, 0, Infinity, 3) spun forever and took the
        // whole test file down with it. An infinite coordinate is not exotic: it is what a
        // division by zero upstream produces, next door to the NaN a projection returns for a
        // point behind the viewer.
        if (!Number.isFinite(x0) || !Number.isFinite(y0) ||
            !Number.isFinite(x1) || !Number.isFinite(y1))
            return;
        // CLIP to the canvas before rasterising, rather than bounding the loop count.
        //
        // "Finite" is not the same as "reasonable": line(0, 0, 1e9, 3) is finite and steps a
        // billion times on a small canvas, since every iteration past the edge still costs a
        // set() call that only rejects it. 1e7 already costs 58ms and it scales linearly, so a
        // units error or an unclamped outlier in plotting code turns one line into a hang.
        //
        // Clamping the ITERATION COUNT was the obvious fix and it is wrong: a line coming from
        // far off-canvas INTO view spends its first thousands of steps outside, so a clamp
        // stops before it arrives and the line silently disappears. Clipping the SEGMENT keeps
        // both properties — bounded work, and every visible dot still drawn.
        //
        // Liang-Barsky against the dot grid, in the aspect-corrected space set() works in.
        const ax0 = x0, ay0 = this.aspect === 1 ? y0 : y0 * this.aspect;
        const ax1 = x1, ay1 = this.aspect === 1 ? y1 : y1 * this.aspect;
        let px = ax1 - ax0, py = ay1 - ay0;
        let t0 = 0, t1 = 1;
        for (const [p, q] of [[-px, ax0], [px, this.width - 1 - ax0],
                              [-py, ay0], [py, this.height - 1 - ay0]]) {
            if (p === 0) {
                if (q < 0) return;               // parallel to this edge and outside it
                continue;
            }
            const r = q / p;
            if (p < 0) { if (r > t1) return; if (r > t0) t0 = r; }
            else       { if (r < t0) return; if (r < t1) t1 = r; }
        }
        // Undo the aspect correction on the way out: set() applies it again.
        const inv = this.aspect === 1 ? 1 : 1 / this.aspect;
        let x = Math.round(ax0 + t0 * px), y = Math.round((ay0 + t0 * py) * inv);
        const xe = Math.round(ax0 + t1 * px), ye = Math.round((ay0 + t1 * py) * inv);
        const dx = Math.abs(xe - x), sx = x < xe ? 1 : -1;
        const dy = -Math.abs(ye - y), sy = y < ye ? 1 : -1;
        let err = dx + dy;
        // Still a counted loop rather than a while(true): the clip above bounds the span, and
        // this costs one comparison per dot to guarantee termination whatever the arithmetic
        // does at the edges.
        const limit = dx - dy + 4;
        for (let n = 0; n <= limit; n++) {
            this.set(x, y, rgb, weight);
            if (x === xe && y === ye)
                break;
            const e2 = 2 * err;
            if (e2 >= dy) { err += dy; x += sx; }
            if (e2 <= dx) { err += dx; y += sy; }
        }
    }

    /**
     * A line that lights every `step`-th dot.
     *
     * Worth having, and the spacing is not cosmetic. Guide lines compete with the data they are
     * pointing at, and on a dense canvas they win — which is backwards. A worked example from
     * the project this came out of: on a 100×28 terminal, solid figures for all 89
     * constellations put 545 lit dots of line against 186 of star, 2.9:1. A step of 3 brings it
     * to about 1.1:1, which finally puts more ink into the subject than into the scaffolding.
     * Colour separates them further, but no colour choice rescues a picture that is mostly
     * guide lines.
     */
    dottedLine(x0, y0, x1, y1, rgb = -1, weight = 0, step = 2) {
        let x = Math.round(x0), y = Math.round(y0);
        const xe = Math.round(x1), ye = Math.round(y1);
        const dx = Math.abs(xe - x), sx = x < xe ? 1 : -1;
        const dy = -Math.abs(ye - y), sy = y < ye ? 1 : -1;
        let err = dx + dy, n = 0;
        const limit = dx - dy + 4;
        for (; n <= limit; n++) {
            if (n % step === 0)
                this.set(x, y, rgb, weight);
            if (x === xe && y === ye)
                break;
            const e2 = 2 * err;
            if (e2 >= dy) { err += dy; x += sx; }
            if (e2 <= dx) { err += dx; y += sy; }
        }
    }

    /**
     * Place text only if the space is free, and return whether it went in.
     *
     * A labelled chart is mostly labels competing for the same few cells, and the failure mode
     * is not subtle: "Saturn" clipped to "Sat" at the frame edge, or one name written through
     * another. Call in priority order and whatever does not fit is simply not drawn, which is
     * what a cartographer would do.
     *
     * `col`/`row` is the anchor the label belongs to; it goes to the right if there is room and
     * flips to the left if there is not, so nothing is ever clipped by the edge.
     */
    tryText(col, row, str, rgb = -1, {pad = 1} = {}) {
        // Snap first, for the same reason text() does — and measure in CHARACTERS, since
        // str.length counts UTF-16 code units and would reserve one cell too many per
        // astral character.
        const r = Math.round(row), anchor = Math.round(col);
        if (!Number.isFinite(r) || !Number.isFinite(anchor) || r < 0 || r >= this.rows)
            return false;
        const len = Array.from(str).length;
        let c = anchor;
        if (c + len > this.cols)
            c = anchor - len - 1;              // flip to the other side of the anchor
        if (c < 0 || c + len > this.cols)
            return false;
        for (let k = -pad; k < len + pad; k++) {
            const cc = c + k;
            // Clamp to the row. Indexing row*cols + c + k without this ran off the end into
            // the neighbouring rows, so a label at the right edge of one row blocked a label
            // at the left edge of the next — silently, in exactly the crowded-chart case
            // this method exists to handle.
            if (cc < 0 || cc >= this.cols)
                continue;
            if (this._glyphs?.has(r * this.cols + cc))
                return false;
        }
        this.text(c, r, str, rgb);
        return true;
    }

    /** Text, written at CELL coordinates — glyphs cannot live on the dot grid. */
    text(col, row, str, rgb = -1) {
        // Snap to the cell grid BEFORE indexing. A fractional index makes the typed-array
        // write vanish (typed arrays discard them) and stores the glyph under a Map key
        // toString() can never look up, so text(2.5, 1, 'hi') returned normally and drew
        // nothing at all. Any caller computing a column from data — col = width / 2 — lands
        // here immediately.
        const r = Math.round(row), c0 = Math.round(col);
        if (!Number.isFinite(r) || !Number.isFinite(c0) || r < 0 || r >= this.rows)
            return;
        // Iterate CHARACTERS, not UTF-16 code units: str[k] splits an astral character
        // (emoji, many CJK extensions) across two cells, so a 3-character label claimed 4
        // cells — and tryText reserves its span from the same count.
        //
        // Control characters are dropped rather than drawn. The canvas is written straight to a
        // terminal, so a label is an injection point: a caller rendering a filename, a username
        // or an API response passed the terminal whatever escapes the string contained, and
        // "\x1b[2J" clears the screen. A newline was as bad in a quieter way — it added a row,
        // so the frame stopped matching the size the caller asked for and every cursor
        // calculation downstream was off by one.
        const chars = Array.from(str).filter(ch => {
            const p = ch.codePointAt(0);
            return p > 0x1f && p !== 0x7f && !(p >= 0x80 && p <= 0x9f);
        });
        for (let k = 0; k < chars.length; k++) {
            const c = c0 + k;
            if (c < 0 || c >= this.cols)
                continue;
            const i = r * this.cols + c;
            // A glyph REPLACES the cell rather than OR-ing into it, so the renderer has to know
            // which cells are text; that is what the glyph map is for.
            this.cells[i] = 0;
            this.colour[i] = rgb;
            this.weight[i] = Infinity;      // text must never lose its colour to a mark
            (this._glyphs ??= new Map()).set(i, chars[k]);
        }
    }

    /**
     * Render to ANSI.
     *
     * Colour escapes are emitted ONLY when the colour changes from the previous cell. On a
     * sparse canvas adjacent cells are overwhelmingly both empty, so this is the difference
     * between ~20 bytes per cell and ~1.
     *
     * `background` is painted explicitly and every line runs the full width. That matters when
     * the drawing assumes a dark ground: a chart of light sources inverts into nonsense on a
     * pale terminal, and a terminal that follows the desktop light/dark schedule will be pale
     * half the time. Pass `background: null` to inherit the terminal's instead.
     */
    toString({colour = true, background = null} = {}) {
        const out = [];
        const bg = colour && background !== null
            ? `\x1b[48;2;${(background >> 16) & 255};${(background >> 8) & 255};${background & 255}m`
            : '';
        for (let r = 0; r < this.rows; r++) {
            // The background is set once per line and never reset mid-line: changing the
            // FOREGROUND does not disturb it, so the per-cell colour escapes below are free to
            // do as they like until the reset at the end.
            let line = bg;
            let cur = -2;
            let curBg = -2;                 // per-CELL background, distinct from the page bg
            for (let c = 0; c < this.cols; c++) {
                const i = r * this.cols + c;
                const g = this._glyphs?.get(i);
                const bits = this.cells[i];
                const cellBg = colour ? (this.bg?.[i] ?? -1) : -1;
                if (!g && bits === 0 && cellBg < 0) {
                    // Empty cell with no background: no colour needed, and skipping the escape
                    // keeps runs of empty canvas to one byte each.
                    if (curBg !== -2 && curBg >= 0) {
                        // A previous cell painted a background; clear it or it runs to the
                        // right-hand edge and floods the rest of the row.
                        line += bg || '\x1b[49m';
                        curBg = -1;
                    }
                    line += ' ';
                    continue;
                }
                if (colour && cellBg !== curBg) {
                    line += cellBg < 0
                        ? (bg || '\x1b[49m')     // back to the page background, or the default
                        : `\x1b[48;2;${(cellBg >> 16) & 255};${(cellBg >> 8) & 255};${cellBg & 255}m`;
                    curBg = cellBg;
                }
                const col = this.colour[i];
                if (colour && col !== cur) {
                    line += col < 0
                        ? '\x1b[39m'
                        : `\x1b[38;2;${(col >> 16) & 255};${(col >> 8) & 255};${col & 255}m`;
                    cur = col;
                }
                line += g ?? String.fromCharCode(BLANK | bits);
            }
            // No padding needed: every cell emits exactly one character, space included, so the
            // line is already the full width and the background reaches the right edge.
            if (colour && (cur !== -2 || curBg !== -2 || bg))
                line += '\x1b[0m';
            out.push(line);
        }
        return out.join('\n');
    }
}
