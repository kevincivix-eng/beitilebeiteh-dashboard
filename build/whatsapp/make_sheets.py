#!/usr/bin/env python3
"""
Build numbered contact sheets from data/experimental/vision-todo.json so a
vision pass can identify many listings per image instead of one at a time.

Each sheet is a 4x3 grid of 12 photos, every cell labelled with its global
index. The index maps back to vision-todo.json[data][i].

Usage: python3 build/whatsapp/make_sheets.py [out_dir]
"""
import json
import os
import sys
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
TODO = os.path.join(ROOT, 'data', 'experimental', 'vision-todo.json')
OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/wa-sheets'

COLS, ROWS = 4, 3
CELL = 400          # cell size in px
LABEL = 30          # label strip height
PER = COLS * ROWS

os.makedirs(OUT, exist_ok=True)
items = json.load(open(TODO, encoding='utf-8'))['data']

sheets = 0
for start in range(0, len(items), PER):
    chunk = items[start:start + PER]
    W = COLS * CELL
    H = ROWS * (CELL + LABEL)
    sheet = Image.new('RGB', (W, H), 'white')
    draw = ImageDraw.Draw(sheet)

    for k, it in enumerate(chunk):
        r, c = divmod(k, COLS)
        x, y = c * CELL, r * (CELL + LABEL)
        try:
            im = Image.open(it['file'])
            im.thumbnail((CELL - 8, CELL - 8))
            im = im.convert('RGB')
            sheet.paste(im, (x + (CELL - im.width) // 2, y + LABEL + (CELL - im.height) // 2))
        except Exception as e:                       # noqa: BLE001
            draw.text((x + 10, y + LABEL + 10), f'ERR {e}', fill='red')
        idx = start + k
        draw.rectangle([x, y, x + CELL, y + LABEL], fill='#4e724d')
        draw.text((x + 8, y + 8), f'#{idx}', fill='white')
        draw.rectangle([x, y, x + CELL - 1, y + LABEL + CELL - 1], outline='#ccc')

    p = os.path.join(OUT, f'sheet-{sheets:03d}.jpg')
    sheet.save(p, quality=72, optimize=True)
    sheets += 1

print(f'{sheets} sheets ({len(items)} photos) -> {OUT}')
