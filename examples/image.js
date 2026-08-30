#!/usr/bin/env node
/**
 * Render an image as braille, with Floyd–Steinberg dithering and per-cell colour.
 *
 * Braille gives 2x4 dots per character cell, so a 64x48 terminal is a 128x192 bitmap —
 * enough to recognise a face. Each dot is one bit, so the tone has to come from DITHERING
 * rather than from grey levels: error diffusion turns a smooth gradient into a dot density
 * the eye reads as shading. Colour is then applied per cell (braille's real constraint —
 * eight dots, one foreground colour), sampled from the same region the dots came from.
 *
 * Input is binary PPM (P6) because braillecanvas has no dependencies and Node cannot decode
 * a JPEG on its own. Convert anything with one line:
 *
 *   python3 -c "from PIL import Image; Image.open('in.jpg').save('out.ppm')"
 *   magick in.jpg out.ppm            # or ImageMagick
 *
 * Usage:
 *   node examples/image.js picture.ppm [--cols 64] [--mono] [--invert] [--no-dither]
 */
import {Canvas} from 'braillecanvas';
import {readFileSync} from 'node:fs';

const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--'));
const flag = f => argv.includes(f);
const opt = (f, d) => {
    const i = argv.indexOf(f);
    return i === -1 ? d : Number(argv[i + 1]);
};
if (!file) {
    console.error('usage: node examples/image.js picture.ppm [--cols 64] [--mono] [--invert]');
    process.exit(1);
}

const COLS = opt('--cols', 64);
const MONO = flag('--mono');
const INVERT = flag('--invert');
// Dither mode: 'fs' (error diffusion, best for large photographic renders), 'ordered'
// (Bayer — regular patterns the eye reads as distinct greys; far more legible when the dot
// count is small), or 'none' (hard threshold, for line art and posterised input).
const MODE = flag('--ordered') ? 'ordered' : flag('--no-dither') ? 'none' : 'fs';
const GAMMA = opt('--gamma', 1.0);

/** Binary PPM (P6). Comments may appear between any two header tokens. */
function readPPM(path) {
    const buf = readFileSync(path);
    let pos = 0;
    const token = () => {
        while (pos < buf.length) {
            const c = buf[pos];
            if (c === 0x23) {                     // '#': skip to end of line
                while (pos < buf.length && buf[pos] !== 0x0a) pos++;
            } else if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
                pos++;
            } else break;
        }
        const start = pos;
        while (pos < buf.length && ![0x20, 0x09, 0x0a, 0x0d].includes(buf[pos])) pos++;
        return buf.toString('ascii', start, pos);
    };
    const magic = token();
    if (magic !== 'P6')
        throw new Error(`expected a binary PPM (P6), got ${magic}`);
    const w = Number(token()), h = Number(token()), max = Number(token());
    if (max !== 255)
        throw new Error(`only 8-bit PPM is supported (maxval ${max})`);
    pos++;                                        // exactly one whitespace byte before the data
    return {w, h, data: buf.subarray(pos, pos + w * h * 3)};
}

const img = readPPM(file);

// Choose rows so the DOTS stay square: dots are 2 per col and 4 per row, and a cell is
// about twice as tall as it is wide, so dot spacing already works out near 1:1.
const dotsW = COLS * 2;
const dotsH = Math.round(dotsW * (img.h / img.w));
const ROWS = Math.max(1, Math.ceil(dotsH / 4));

/** Box-filter the source into the dot grid: average every source pixel that maps to a dot. */
function sample() {
    const lum = new Float32Array(dotsW * dotsH);
    const rgb = new Float32Array(dotsW * dotsH * 3);
    const sx = img.w / dotsW, sy = img.h / dotsH;
    for (let y = 0; y < dotsH; y++) {
        const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
        for (let x = 0; x < dotsW; x++) {
            const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
            let r = 0, g = 0, b = 0, n = 0;
            for (let yy = y0; yy < y1 && yy < img.h; yy++) {
                for (let xx = x0; xx < x1 && xx < img.w; xx++) {
                    const i = (yy * img.w + xx) * 3;
                    r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2];
                    n++;
                }
            }
            if (!n) n = 1;
            r /= n; g /= n; b /= n;
            const k = y * dotsW + x;
            rgb[k * 3] = r; rgb[k * 3 + 1] = g; rgb[k * 3 + 2] = b;
            // Rec. 601 luma: the eye is far more sensitive to green than to blue, and a
            // plain (r+g+b)/3 makes blues read far lighter than they look.
            lum[k] = 0.299 * r + 0.587 * g + 0.114 * b;
        }
    }
    return {lum, rgb};
}

const {lum, rgb} = sample();

if (GAMMA !== 1.0)
    for (let i = 0; i < lum.length; i++)
        lum[i] = 255 * Math.pow(lum[i] / 255, GAMMA);

if (INVERT)
    for (let i = 0; i < lum.length; i++) lum[i] = 255 - lum[i];

/**
 * Floyd–Steinberg error diffusion.
 *
 * A plain threshold throws away everything between black and white, which on a portrait
 * means the face becomes a blob. Diffusing the quantisation error to the neighbours not yet
 * visited converts tone into dot DENSITY, which is the only tone a 1-bit grid has.
 *
 * Good for photographs at high dot counts. At small sizes it works AGAINST you: it preserves
 * local average tone by scattering error, so every region lands near its own mean and the
 * picture reads as uniform texture rather than shapes. Use --ordered for small renders.
 */
function ditherFS(l) {
    const out = new Uint8Array(dotsW * dotsH);
    const err = Float32Array.from(l);
    for (let y = 0; y < dotsH; y++) {
        for (let x = 0; x < dotsW; x++) {
            const i = y * dotsW + x;
            const old = err[i];
            const lit = old >= 128 ? 1 : 0;
            out[i] = lit;
            const e = old - (lit ? 255 : 0);
            const add = (xx, yy, f) => {
                if (xx < 0 || xx >= dotsW || yy >= dotsH) return;
                err[yy * dotsW + xx] += e * f;
            };
            add(x + 1, y,     7 / 16);
            add(x - 1, y + 1, 3 / 16);
            add(x,     y + 1, 5 / 16);
            add(x + 1, y + 1, 1 / 16);
        }
    }
    return out;
}

// 4x4 Bayer matrix, normalised to 0..1. Ordered dithering compares each pixel against a
// fixed threshold pattern, so equal tones always produce the SAME dot arrangement — which
// the eye reads as a distinct shade rather than as noise. That regularity is what makes a
// face legible at a few thousand dots, where error diffusion turns everything to texture.
const BAYER4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
].map(r => r.map(v => (v + 0.5) / 16));

function ditherOrdered(l) {
    const out = new Uint8Array(dotsW * dotsH);
    for (let y = 0; y < dotsH; y++)
        for (let x = 0; x < dotsW; x++)
            out[y * dotsW + x] = (l[y * dotsW + x] / 255) > BAYER4[y & 3][x & 3] ? 1 : 0;
    return out;
}

function threshold(l) {
    const out = new Uint8Array(dotsW * dotsH);
    for (let i = 0; i < l.length; i++) out[i] = l[i] >= 128 ? 1 : 0;
    return out;
}

const bits = MODE === 'ordered' ? ditherOrdered(lum)
    : MODE === 'none' ? threshold(lum)
    : ditherFS(lum);
const c = new Canvas(COLS, ROWS);

for (let y = 0; y < dotsH; y++) {
    for (let x = 0; x < dotsW; x++) {
        if (!bits[y * dotsW + x]) continue;
        let colour = -1, weight = 0;
        if (!MONO) {
            const k = (y * dotsW + x) * 3;
            let r = rgb[k], g = rgb[k + 1], b = rgb[k + 2];
            // Lift the colour towards full brightness. A lit dot is the image's LIGHT, and
            // painting it in the region's average — which includes the dark pixels that were
            // dithered off — renders the whole picture muddy.
            const peak = Math.max(r, g, b) || 1;
            const lift = Math.min(255 / peak, 1.6);
            r = Math.min(255, r * lift); g = Math.min(255, g * lift); b = Math.min(255, b * lift);
            colour = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
            // Brighter dots win the cell, so a highlight is never recoloured by a shadow
            // sharing its cell.
            weight = 0.299 * r + 0.587 * g + 0.114 * b;
        }
        c.set(x, y, colour, weight);
    }
}

process.stdout.write(c.toString({colour: !MONO, background: MONO ? null : 0x000000}) + '\n');
