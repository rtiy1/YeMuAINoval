#!/usr/bin/env python3
"""Generate the desktop app icon set for src-tauri/icons.

Produces PNG sizes (32/128/256/512/1024), Windows .ico and macOS .icns
from a single rendered 1024x1024 canvas. Pure stdlib (zlib), no Pillow.

Run:  python3 scripts/generate-icons.py
"""
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src-tauri", "icons")

# chocolate-y dark night background + gold crescent moon
BG = (31, 36, 55, 255)       # #1f2437
MOON = (240, 190, 96, 255)   # #f0be60


def render(size):
    """Return list of rows, each row = list of (r,g,b,a) tuples."""
    canvas = [[BG for _ in range(size)] for _ in range(size)]
    # map 0..size -> 0..1
    cx = size * 0.5
    cy = size * 0.5
    outer = size * 0.42
    inner_dx = outer * 0.38
    inner = outer * 0.90
    for y in range(size):
        row = canvas[y]
        dy = (y + 0.5 - cy) / size
        for x in range(size):
            dx = (x + 0.5 - cx) / size
            d_outer = (dx * dx + dy * dy) ** 0.5
            if d_outer > outer:
                continue  # background
            # crescent: outside inner (offset) circle -> moon colour
            ix = (x + 0.5 - (cx + inner_dx * size)) / size
            iy = dy
            if (ix * ix + iy * iy) ** 0.5 < inner:
                continue  # inside inner circle -> background
            row[x] = MOON
    return canvas


def encode_png(rows):
    height = len(rows)
    width = len(rows[0])
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter: none
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def write_png(path, size, png_cache):
    if size not in png_cache:
        png_cache[size] = encode_png(render(size))
    with open(path, "wb") as fh:
        fh.write(png_cache[size])


def write_ico(path, png_cache):
    png = png_cache[256]
    # ICO header + one directory entry (width/height byte 0 means 256)
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png), 22)
    with open(path, "wb") as fh:
        fh.write(header + entry + png)


def write_icns(path, png_cache):
    # icns with PNG-encoded chunks: ic07(128) ic08(256) ic09(512) ic10(1024)
    chunks = []
    for kind, size in ((b"ic07", 128), (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024)):
        data = png_cache[size]
        chunks.append(kind + struct.pack(">I", len(data) + 8) + data)
    body = b"".join(chunks)
    total = 8 + len(body)
    with open(path, "wb") as fh:
        fh.write(b"icns" + struct.pack(">I", total) + body)


def main():
    os.makedirs(OUT, exist_ok=True)
    png_cache = {}
    targets = {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
        "app-icon.png": 1024,
    }
    for name, size in targets.items():
        write_png(os.path.join(OUT, name), size, png_cache)
    write_ico(os.path.join(OUT, "icon.ico"), png_cache)
    write_icns(os.path.join(OUT, "icon.icns"), png_cache)
    print(f"icons generated in {OUT}")
    print("  32x32.png 128x128.png 128x128@2x.png icon.png app-icon.png icon.ico icon.icns")


if __name__ == "__main__":
    main()
