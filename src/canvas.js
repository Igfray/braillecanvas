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
        // The glyph map too. Without this, every label ever drawn stays on the canvas — which
        // on a static render looks fine and on an animated one smears text across the frame.
        this._glyphs?.clear();
    }

    /**
     * Light one dot at DOT coordinates.
     *
     * `weight` decides which mark owns the cell's colour when several share it — pass a
     * magnitude, a z-depth, an importance, whatever ranks your marks. Ties go to the newer one.
     */
    set(x, y, rgb = -1, weight = 0) {
        const dx = x | 0, dy = y | 0;
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
        let x = Math.round(x0), y = Math.round(y0);
        const xe = Math.round(x1), ye = Math.round(y1);
        const dx = Math.abs(xe - x), sx = x < xe ? 1 : -1;
        const dy = -Math.abs(ye - y), sy = y < ye ? 1 : -1;
        let err = dx + dy;
        // A guard rather than a while(true): a NaN coordinate would otherwise spin forever, and
        // NaN is exactly what a projection hands back for a point behind the viewer.
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
        if (row < 0 || row >= this.rows)
            return false;
        let c = col;
        if (c + str.length > this.cols)
            c = col - str.length - 1;          // flip to the other side of the anchor
        if (c < 0 || c + str.length > this.cols)
            return false;
        for (let k = -pad; k < str.length + pad; k++) {
            const i = row * this.cols + c + k;
            if (this._glyphs?.has(i))
                return false;
        }
        this.text(c, row, str, rgb);
        return true;
    }

    /** Text, written at CELL coordinates — glyphs cannot live on the dot grid. */
    text(col, row, str, rgb = -1) {
        if (row < 0 || row >= this.rows)
            return;
        for (let k = 0; k < str.length; k++) {
            const c = col + k;
            if (c < 0 || c >= this.cols)
                continue;
            const i = row * this.cols + c;
            // A glyph REPLACES the cell rather than OR-ing into it, so the renderer has to know
            // which cells are text; that is what the glyph map is for.
            this.cells[i] = 0;
            this.colour[i] = rgb;
            this.weight[i] = Infinity;      // text must never lose its colour to a mark
            (this._glyphs ??= new Map()).set(i, str[k]);
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
            for (let c = 0; c < this.cols; c++) {
                const i = r * this.cols + c;
                const g = this._glyphs?.get(i);
                const bits = this.cells[i];
                if (!g && bits === 0) {
                    // Empty cell: no colour needed, and skipping the escape keeps runs of empty
                    // canvas to one byte each.
                    line += ' ';
                    continue;
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
            if (colour && (cur !== -2 || bg))
                line += '\x1b[0m';
            out.push(line);
        }
        return out.join('\n');
    }
}
