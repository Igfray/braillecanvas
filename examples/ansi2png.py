#!/usr/bin/env python3
"""Render captured ANSI output to a PNG, so the README can show what the terminal shows.

Handles exactly the escapes braillecanvas emits: 24-bit foreground (38;2;r;g;b),
24-bit background (48;2;r;g;b), and reset (0). Anything else is skipped rather than
guessed at.
"""
import re
import sys
from PIL import Image, ImageDraw, ImageFont

SRC = sys.argv[1]
OUT = sys.argv[2]
# DejaVu Sans MONO has no braille block (U+2800) — glyphs rendered as tofu boxes on the
# first attempt. Unifont covers braille completely and is exactly 8x16 per cell, which
# suits a dot grid; text stays in DejaVu Mono, which is far more readable for prose.
FONT_TEXT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_BRAILLE = "/usr/share/fonts/opentype/unifont/unifont.otf"
SIZE = 16
CW, CH = 9, 19            # cell advance; measured below and corrected
PAD = 14
DEFAULT_BG = (13, 17, 23)
DEFAULT_FG = (200, 205, 212)

ansi = re.compile(r"\x1b\[([0-9;]*)m")


def cells(line):
    """(char, fg, bg) per character, resolving SGR state as we go."""
    fg, bg = DEFAULT_FG, DEFAULT_BG
    out, pos = [], 0
    for m in ansi.finditer(line):
        for ch in line[pos:m.start()]:
            out.append((ch, fg, bg))
        parts = [p for p in m.group(1).split(";") if p != ""]
        i = 0
        while i < len(parts):
            p = parts[i]
            if p == "0":
                fg, bg = DEFAULT_FG, DEFAULT_BG
                i += 1
            elif p in ("38", "48") and i + 4 < len(parts) and parts[i + 1] == "2":
                rgb = tuple(int(x) for x in parts[i + 2:i + 5])
                if p == "38":
                    fg = rgb
                else:
                    bg = rgb
                i += 5
            else:
                i += 1
        pos = m.end()
    for ch in line[pos:]:
        out.append((ch, fg, bg))
    return out


raw = open(SRC, encoding="utf-8").read()
# Keep only the LAST frame: the capture overprints frames with \x1b[H.
frames = raw.split("\x1b[H")
body = frames[-1] if len(frames) > 1 else raw
body = body.replace("\x1b[2J", "").replace("\x1b[?25l", "").replace("\x1b[?25h", "")
lines = [ln for ln in body.split("\n")]
while lines and not ansi.sub("", lines[-1]).strip():
    lines.pop()
while lines and not ansi.sub("", lines[0]).strip():
    lines.pop(0)

font_text = ImageFont.truetype(FONT_TEXT, SIZE)
font_braille = ImageFont.truetype(FONT_BRAILLE, SIZE)
# Measure a braille glyph so the grid matches the font rather than a guess.
probe = Image.new("RGB", (60, 40))
d0 = ImageDraw.Draw(probe)
bbox = d0.textbbox((0, 0), "\u28ff", font=font_braille)
CW = max(8, bbox[2] - bbox[0])
ascent, descent = font_braille.getmetrics()
CH = ascent + descent

is_braille = lambda ch: "\u2800" <= ch <= "\u28ff"

width = max(len(ansi.sub("", ln)) for ln in lines)
img = Image.new("RGB", (width * CW + PAD * 2, len(lines) * CH + PAD * 2), DEFAULT_BG)
draw = ImageDraw.Draw(img)

for row, line in enumerate(lines):
    y = PAD + row * CH
    for col, (ch, fg, bg) in enumerate(cells(line)):
        x = PAD + col * CW
        if bg != DEFAULT_BG:
            draw.rectangle([x, y, x + CW, y + CH], fill=bg)
        if ch.strip():
            draw.text((x, y), ch, font=font_braille if is_braille(ch) else font_text, fill=fg)

img.save(OUT)
print(f"{OUT}  {img.width}x{img.height}  ({len(lines)} rows x {width} cols, cell {CW}x{CH})")
