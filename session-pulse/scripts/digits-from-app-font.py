"""Extract the digit glyphs session-pulse rolls, from the Claude app's own UI font.

Reads the Anthropic Sans font installed with the Claude desktop app, sets it to
the weight the app draws its text in, and writes the outlines of 0-9, % and the
letters the state chips use as SVG path data to
~/.claude/mods-data/session-pulse/digits.json. The mod draws its rolling
percent and its state chips with them, so they match the app's text exactly.
Nothing of the font is copied into the mod's own files.

Run with: uv run --with fonttools python scripts/digits-from-app-font.py
"""
import json
import os
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

FONT = '/Applications/Claude.app/Contents/Resources/fonts/AnthropicSans-Romans-Variable-25x258.ttf'
OUT = os.path.expanduser('~/.claude/mods-data/session-pulse/digits.json')
WEIGHT = 400  # the app's body text, measured against a screenshot at 13px

if not os.path.exists(FONT):
    sys.exit(f'Claude app font not found: {FONT}')
font = instantiateVariableFont(TTFont(FONT), {'wght': WEIGHT, 'opsz': 16})
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
upm = font['head'].unitsPerEm
out = {'source': os.path.basename(FONT), 'weight': WEIGHT, 'unitsPerEm': upm, 'capHeight': 0, 'glyphs': {}}
for ch in '0123456789%' + 'abcdefghijklmnopqrstuvwxyz' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + " .-/…'":
    if ord(ch) not in cmap:
        continue
    name = cmap[ord(ch)]
    pen = SVGPathPen(glyphs)
    glyphs[name].draw(pen)
    bounds = BoundsPen(glyphs)
    glyphs[name].draw(bounds)
    if ch.isdigit() and bounds.bounds:
        out['capHeight'] = max(out['capHeight'], bounds.bounds[3])
    out['glyphs'][ch] = {'advance': font['hmtx'][name][0], 'path': pen.getCommands()}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w') as f:
    json.dump(out, f)
print(f'wrote {OUT} ({os.path.getsize(OUT)} bytes)')
