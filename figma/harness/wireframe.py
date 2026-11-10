#!/usr/bin/env python3
"""
Draws wireframe scenes as JPEGs, for the live trace run (tests/trace-live.test.ts):
the fake Figma file's export reads what the scratch copies draw
(tests/wireframe.ts sceneOf) and this draws it, so the live model sees a
picture of the screen. Test harness only; the plugin exports through Figma.

    uv run --no-project --with pillow python harness/wireframe.py

One scene per line on stdin, as JSON {width, height, ops}; one answer per
line on stdout: "OK <base64 JPEG>", or "ERR <why>" when a scene can't be
drawn. Ops are drawn in order, each clipped to its clip box:
  fill   a box (or ellipse) in a colour
  stroke a box's (or ellipse's) outline, inside it
  image  a grey placeholder for an image fill
  text   text in a colour, wrapped to its box's width
"""
from __future__ import annotations

import base64
import io
import json
import sys
from functools import lru_cache
from typing import Any, Dict, List, Tuple

from PIL import Image, ImageDraw, ImageFont

JPEG_QUALITY = 80
PLACEHOLDER = (207, 207, 212, 255)
PLACEHOLDER_INK = (110, 110, 120, 255)


@lru_cache(maxsize=None)
def font(size: int) -> ImageFont.FreeTypeFont:
    # Pillow's own sans serif at any size, the same on every machine.
    return ImageFont.load_default(size=size)


def rgba(color: Dict[str, float], opacity: float) -> Tuple[int, int, int, int]:
    return (round(color["r"] * 255), round(color["g"] * 255), round(color["b"] * 255),
            round(max(0.0, min(1.0, color["a"] * opacity)) * 255))


def place(canvas: Image.Image, layer: Image.Image, x: int, y: int, clip: Dict[str, float]) -> None:
    """Composites ``layer`` with its top left at (x, y), cut to ``clip`` and the canvas."""
    x0 = max(x, round(clip["x"]), 0)
    y0 = max(y, round(clip["y"]), 0)
    x1 = min(x + layer.width, round(clip["x"] + clip["width"]), canvas.width)
    y1 = min(y + layer.height, round(clip["y"] + clip["height"]), canvas.height)
    if x1 <= x0 or y1 <= y0:
        return
    canvas.alpha_composite(layer.crop((x0 - x, y0 - y, x1 - x, y1 - y)), (x0, y0))


def wrap(text: str, face: ImageFont.FreeTypeFont, width: float) -> List[str]:
    lines: List[str] = []
    for paragraph in text.split("\n"):
        line = ""
        for word in paragraph.split(" "):
            candidate = f"{line} {word}" if line else word
            if line and face.getlength(candidate) > width:
                lines.append(line)
                line = word
            else:
                line = candidate
        lines.append(line)
    return lines


def draw_op(canvas: Image.Image, op: Dict[str, Any]) -> None:
    box, clip, opacity = op["box"], op["clip"], op["opacity"]
    x, y = round(box["x"]), round(box["y"])
    w, h = max(1, round(box["width"])), max(1, round(box["height"]))
    kind = op["kind"]
    if kind == "text":
        size = int(op["size"])
        face = font(size)
        line = round(size * 1.25)
        lines = wrap(op["text"], face, box["width"])
        # One line sits in the middle of its box; more start at the top. Text may run below its box, as in Figma.
        top = (h - line) / 2 if len(lines) == 1 and h < 2 * line else 0
        layer = Image.new("RGBA", (w + size, max(h, round(top) + line * len(lines))), (0, 0, 0, 0))
        pen = ImageDraw.Draw(layer)
        for i, text in enumerate(lines):
            pen.text((0, top + line * i + line / 2), text, font=face, fill=rgba(op["color"], opacity), anchor="lm")
        place(canvas, layer, x, y, clip)
        return
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    pen = ImageDraw.Draw(layer)
    shape = pen.ellipse if op.get("round") else pen.rectangle
    if kind == "fill":
        shape((0, 0, w - 1, h - 1), fill=rgba(op["color"], opacity))
    elif kind == "stroke":
        shape((0, 0, w - 1, h - 1), outline=rgba(op["color"], opacity), width=max(1, round(op["weight"])))
    elif kind == "image":
        alpha = round(255 * opacity)
        pen.rectangle((0, 0, w - 1, h - 1), fill=PLACEHOLDER[:3] + (alpha,))
        ink = PLACEHOLDER_INK[:3] + (alpha,)
        pen.line((0, 0, w - 1, h - 1), fill=ink)
        pen.line((0, h - 1, w - 1, 0), fill=ink)
        pen.text((w / 2, h / 2), "image", font=font(12), fill=ink, anchor="mm")
    else:
        raise ValueError(f"the wireframe draws no {kind!r} op")
    place(canvas, layer, x, y, clip)


def draw(scene: Dict[str, Any]) -> bytes:
    canvas = Image.new("RGBA", (int(scene["width"]), int(scene["height"])), (255, 255, 255, 255))
    for op in scene["ops"]:
        draw_op(canvas, op)
    out = io.BytesIO()
    canvas.convert("RGB").save(out, format="JPEG", quality=JPEG_QUALITY)
    return out.getvalue()


def main() -> None:
    for raw in sys.stdin:
        if not raw.strip():
            continue
        try:
            answer = "OK " + base64.b64encode(draw(json.loads(raw))).decode()
        except Exception as exc:  # each failure goes back to the scene's caller, named
            answer = f"ERR {type(exc).__name__}: {exc}".replace("\n", " ")
        sys.stdout.write(answer + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
