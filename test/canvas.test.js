// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {Canvas} from '../src/canvas.js';

const plain = c => c.toString({colour: false});

test('braille bit order is the historical one, not raster order', () => {
    // THE TEST THAT CATCHES THE CLASSIC MISTAKE. Braille numbers its dots
    //     1 4
    //     2 5
    //     3 6
    //     7 8
    // so the bit for (col,row) is NOT row*2+col. Getting this wrong still renders something —
    // it just renders it mirrored and scrambled, which is easy to mistake for a projection bug.
    const cases = [
        [0, 0, 0x01], [0, 1, 0x02], [0, 2, 0x04], [0, 3, 0x40],
        [1, 0, 0x08], [1, 1, 0x10], [1, 2, 0x20], [1, 3, 0x80],
    ];
    for (const [x, y, bit] of cases) {
        const c = new Canvas(1, 1);
        c.set(x, y);
        assert.equal(plain(c).codePointAt(0), 0x2800 | bit, `dot (${x},${y})`);
    }
});

test('all eight dots give the full cell', () => {
    const c = new Canvas(1, 1);
    for (let x = 0; x < 2; x++)
        for (let y = 0; y < 4; y++)
            c.set(x, y);
    assert.equal(plain(c), '⣿');
});

test('an empty canvas is spaces, not blank braille', () => {
    // U+2800 is a *visible* blank braille cell in some fonts and has a different width in
    // others. An empty canvas must emit ordinary spaces or the layout drifts.
    assert.equal(plain(new Canvas(3, 1)), '   ');
});

test('out-of-range dots are dropped silently, including negatives', () => {
    const c = new Canvas(2, 1);
    for (const [x, y] of [[-1, 0], [0, -1], [4, 0], [0, 4], [1e9, 1e9]])
        c.set(x, y);
    assert.equal(plain(c), '  ');
});

test('a NaN coordinate terminates instead of spinning forever', () => {
    // A projection hands back NaN for a point behind the viewer. Without the loop guard this is
    // an infinite loop, i.e. a hung terminal rather than a visible bug.
    const c = new Canvas(4, 2);
    c.line(NaN, 0, 3, 3);
    c.line(0, 0, NaN, NaN);
    c.dottedLine(NaN, NaN, NaN, NaN);
    assert.ok(true, 'returned');
});

test('the heavier mark keeps the cell colour', () => {
    // Colour is per cell but several marks can share one. A dim mark arriving later must not
    // steal a bright one's colour — on a dense canvas that is the difference between a cluster
    // reading as bright and reading as grey.
    const c = new Canvas(1, 1);
    c.set(0, 0, 0xff0000, 5);
    c.set(1, 1, 0x0000ff, 1);
    assert.equal(c.colour[0], 0xff0000);
    // ...and the heavier one wins even when it arrives second
    const d = new Canvas(1, 1);
    d.set(0, 0, 0x0000ff, 1);
    d.set(1, 1, 0xff0000, 5);
    assert.equal(d.colour[0], 0xff0000);
});

test('text outranks any mark for colour', () => {
    const c = new Canvas(4, 1);
    c.set(0, 0, 0xff0000, 1e6);
    c.text(0, 0, 'A', 0x00ff00);
    assert.equal(c.colour[0], 0x00ff00);
});

test('a glyph replaces its cell rather than OR-ing into it', () => {
    const c = new Canvas(1, 1);
    c.set(0, 0);
    c.text(0, 0, 'X');
    assert.equal(plain(c), 'X');
});

test('clear() forgets glyphs too', () => {
    // Miss this and every label ever drawn stays on the canvas. On a static render it looks
    // fine; on an animated one text smears across the frame.
    const c = new Canvas(4, 1);
    c.text(0, 0, 'abcd');
    c.clear();
    assert.equal(plain(c), '    ');
});

test('tryText refuses to overwrite an existing label', () => {
    const c = new Canvas(20, 1);
    assert.equal(c.tryText(0, 0, 'first', -1, {pad: 0}), true);
    assert.equal(c.tryText(0, 0, 'second', -1, {pad: 0}), false);
    assert.ok(plain(c).startsWith('first'));
});

test('pad keeps labels from touching', () => {
    const c = new Canvas(20, 1);
    c.tryText(0, 0, 'ab', -1, {pad: 1});
    assert.equal(c.tryText(2, 0, 'cd', -1, {pad: 1}), false, 'adjacent is refused with padding');
});

test('a label at the right edge flips to the left of its anchor rather than clipping', () => {
    // The failure this prevents is "Saturn" rendering as "Sat" at the frame edge.
    const c = new Canvas(10, 1);
    assert.equal(c.tryText(8, 0, 'label', -1, {pad: 0}), true);
    const line = plain(c);
    assert.ok(line.includes('label'), `whole label present: ${JSON.stringify(line)}`);
    assert.equal(line.length, 10);
});

test('a label that cannot fit either side is refused, not clipped', () => {
    const c = new Canvas(4, 1);
    assert.equal(c.tryText(0, 0, 'far too long', -1, {pad: 0}), false);
    assert.equal(plain(c), '    ');
});

test('rows outside the canvas are refused', () => {
    const c = new Canvas(8, 1);
    assert.equal(c.tryText(0, -1, 'x'), false);
    assert.equal(c.tryText(0, 5, 'x'), false);
});

test('dottedLine lights every step-th dot', () => {
    const solid = new Canvas(10, 1);
    solid.line(0, 0, 19, 0);
    const dotted = new Canvas(10, 1);
    dotted.dottedLine(0, 0, 19, 0, -1, 0, 3);
    const lit = s => [...plain(s)].filter(ch => ch !== ' ').length;
    assert.ok(lit(dotted) < lit(solid), 'dotted uses less ink than solid');
});

test('colour escapes are emitted only when the colour changes', () => {
    // Runs of empty canvas must cost one byte per cell, not twenty.
    const c = new Canvas(6, 1);
    c.set(0, 0, 0xff0000, 1);
    c.set(2, 0, 0xff0000, 1);   // same colour, adjacent cell -> no second escape
    const out = c.toString({colour: true});
    assert.equal((out.match(/\x1b\[38;2;/g) || []).length, 1);
});

test('background is opt-in and reaches the full width', () => {
    const bare = new Canvas(3, 1).toString({colour: true});
    assert.ok(!bare.includes('\x1b[48;2;'), 'no background unless asked for');
    const painted = new Canvas(3, 1).toString({colour: true, background: 0x080c14});
    assert.ok(painted.includes('\x1b[48;2;8;12;20m'));
    assert.ok(painted.endsWith('\x1b[0m'));
});

test('dot grid is 2x4 per cell', () => {
    const c = new Canvas(40, 12);
    assert.equal(c.width, 80);
    assert.equal(c.height, 48);
});


// ── Defects found by probing the library rather than reading it (2026-08-30) ──

test('a NaN coordinate lights nothing, rather than the top-left corner', () => {
    // `x | 0` coerces NaN to 0 BEFORE the bounds check, so a projection that returns NaN —
    // the exact case line()'s loop guard documents — planted a dot at (0,0). line() was
    // protected; set() was not.
    const c = new Canvas(10, 5);
    c.set(NaN, NaN, 0xff0000, 1);
    c.set(undefined, 3, 0xff0000, 1);
    c.set(2, NaN, 0xff0000, 1);
    assert.equal(c.cells.reduce((a, b) => a + b, 0), 0, 'NaN must not light a dot');
});

test('a coordinate just off the top-left is out of bounds, not rounded into view', () => {
    // (-0.5)|0 is -0, which is NOT < 0, so the guard missed it and the dot landed at (0,0).
    const c = new Canvas(10, 5);
    c.set(-0.5, -0.5, 0xff0000, 1);
    assert.equal(c.cells.reduce((a, b) => a + b, 0), 0, 'a negative fraction is outside the canvas');
});

test('a label at one row edge does not block a label at the next row edge', () => {
    // The collision scan indexed row*cols + c + k without clamping to the row, so k = -pad
    // read the LAST cell of the PREVIOUS row. A right-edge label blocked a left-edge one
    // on the row below — silent, and exactly the crowded case tryText exists for.
    const c = new Canvas(20, 5);
    c.text(17, 1, 'XYZ', 0xffffff);
    assert.ok(c.tryText(0, 2, 'ok', 0x00ff00), 'a different row must not collide');
    assert.ok(c.tryText(0, 0, 'up', 0x00ff00), 'nor the row above');
});

test('a label still refuses to overwrite one on its own row', () => {
    const c = new Canvas(20, 5);
    c.text(5, 2, 'taken', 0xffffff);
    assert.ok(!c.tryText(4, 2, 'x', 0x00ff00), 'the pad must still catch a real neighbour');
    assert.ok(!c.tryText(5, 2, 'y', 0x00ff00), 'and a direct overlap');
});

test('aspect stretches the vertical axis rather than being decorative', () => {
    // aspect was stored and documented but never read by any method: the two canvases
    // below were byte-identical. It now scales y about the origin, so a caller correcting
    // the ~6% residual dot aspect gets a circle instead of a 6%-flat ellipse.
    const flat = new Canvas(20, 10, {aspect: 1.0});
    const tall = new Canvas(20, 10, {aspect: 2.0});
    for (const c of [flat, tall]) c.set(4, 8, 0xffffff, 1);
    assert.notDeepEqual(Array.from(flat.cells), Array.from(tall.cells),
        'aspect must change where a dot lands');
    // y=8 at aspect 2 lands at y=16; both are in range, so the difference is real.
    const at = (c, x, y) => (c.cells[(y >> 2) * c.cols + (x >> 1)] ?? 0) !== 0;
    assert.ok(at(flat, 4, 8), 'aspect 1 puts it at y=8');
    assert.ok(at(tall, 4, 16), 'aspect 2 puts it at y=16');
});

test('aspect defaults to 1 and leaves coordinates untouched', () => {
    const plain = new Canvas(20, 10);
    const explicit = new Canvas(20, 10, {aspect: 1.0});
    for (const c of [plain, explicit]) c.line(0, 0, 30, 30, 0xffffff, 1);
    assert.deepEqual(Array.from(plain.cells), Array.from(explicit.cells));
});

test('a fractional cell coordinate is snapped, not silently dropped', () => {
    // text() indexed a typed array with row*cols + col. A fractional index makes the write
    // vanish (typed arrays discard them) AND stores the glyph under an unreachable Map key,
    // so text(2.5, 1, 'hi') returned normally, kept 2 glyphs at keys 22.5/23.5, and rendered
    // an empty row. Computing a column from data — col = width / 2 — hits this immediately.
    const c = new Canvas(20, 5);
    c.text(2.5, 1.5, 'hi', 0xffffff);
    // Math.round(1.5) is 2 — the label lands on row 2. (My first version of this test
    // asserted row 1 and failed against correct code: the test was wrong, not the fix.)
    assert.ok(c.toString({colour: false}).split('\n')[2].includes('hi'),
        'the label must actually render');
    for (const k of c._glyphs.keys())
        assert.ok(Number.isInteger(k), `glyph key ${k} is not an integer`);
});

test('a fractional coordinate reaches tryText too', () => {
    const c = new Canvas(20, 5);
    assert.ok(c.tryText(3.7, 2.2, 'ok', 0xffffff));
    assert.ok(c.toString({colour: false}).split('\n')[2].includes('ok'));
});

test('an astral character occupies one cell, not two', () => {
    // str[k] indexes UTF-16 code UNITS, so an emoji surrogate pair was split across two
    // cells. It happened to render because the halves sat adjacent, but the cell accounting
    // was wrong by one per astral char — which is what tryText reserves space with.
    const c = new Canvas(20, 3);
    c.text(0, 0, 'a\u{1F600}b', 0xffffff);
    assert.equal(c._glyphs.size, 3, 'three characters should occupy three cells');
});

test('a canvas cannot be created with a negative size', () => {
    // Previously threw a raw RangeError from the typed-array constructor:
    // "Invalid typed array length: -15", which names nothing the caller passed.
    assert.throws(() => new Canvas(-5, 3), /cols|rows|size/i);
    assert.throws(() => new Canvas(3, -5), /cols|rows|size/i);
    assert.throws(() => new Canvas(2.5, 3), /integer/i);
});
