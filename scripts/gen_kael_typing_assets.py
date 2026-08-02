"""Compose Kael's typing portal and readable rune throws onto approved body motion."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "public" / "pixel" / "_candidates" / "kael_typing_throw_body_v4"
OUTPUT = ROOT / "public" / "pixel" / "_candidates" / "kael_typing_v4"
REVIEW = ROOT / "assets-src" / "wip" / "runtime-review"

VOID = (3, 2, 10, 255)
VIOLET_DARK = (67, 21, 112, 255)
VIOLET = (150, 45, 255, 255)
VIOLET_HI = (214, 151, 255, 255)
WHITE = (248, 242, 255, 255)
INKS = ((55, 20, 93, 255), (25, 34, 89, 255), (89, 20, 74, 255))


def load_frames(folder: Path) -> list[Image.Image]:
    paths = sorted(folder.glob("frame_*.png"), key=lambda p: int(p.stem.split("_")[-1]))
    if not paths:
        raise FileNotFoundError(folder)
    return [Image.open(path).convert("RGBA") for path in paths]


def save_frames(folder: Path, frames: list[Image.Image]) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob("frame_*.png"):
        old.unlink()
    for index, frame in enumerate(frames):
        frame.save(folder / f"frame_{index}.png")


def portal_points(cx: int, cy: int, half_w: int, half_h: int) -> list[tuple[int, int]]:
    return [
        (cx, cy - half_h),
        (cx + 2, cy - half_h + 1),
        (cx + half_w - 1, cy - half_h // 2),
        (cx + half_w + 1, cy - 4),
        (cx + half_w, cy + 2),
        (cx + half_w - 1, cy + half_h // 2),
        (cx + 2, cy + half_h),
        (cx - 1, cy + half_h - 1),
        (cx - half_w + 1, cy + half_h // 2),
        (cx - half_w - 1, cy + 3),
        (cx - half_w, cy - 4),
        (cx - half_w + 1, cy - half_h // 2),
        (cx - 2, cy - half_h + 1),
    ]


def draw_portal(image: Image.Image, phase: float = 1.0, flash: int = 0) -> None:
    if phase <= 0:
        return
    phase = max(0.08, min(1.0, phase))
    cx, cy = 117, 58
    half_w = max(1, round(6 * phase))
    half_h = max(3, round(17 * phase))
    points = portal_points(cx, cy, half_w, half_h)
    closed = points + [points[0]]
    draw = ImageDraw.Draw(image)

    # Sparse outer glow remains pixel-sharp at taskbar scale.
    if phase > 0.35:
        for x, y in points[::2]:
            draw.point((x - 1, y), fill=VIOLET_DARK)
            draw.point((x + 1, y), fill=VIOLET_DARK)
    draw.polygon(points, fill=VOID)
    draw.line(closed, fill=VIOLET, width=2)
    for start in (0, 3, 6, 9):
        draw.line(
            [points[start], points[(start + 1) % len(points)]],
            fill=WHITE if flash or start in (0, 6) else VIOLET_HI,
            width=1,
        )
    draw.point((cx - half_w - 2, cy - 5), fill=VIOLET_HI)
    draw.point((cx + half_w + 2, cy + 5), fill=VIOLET)
    if flash:
        draw.point((cx - half_w - 3, cy), fill=WHITE)
        draw.point((cx + half_w + 3, cy - 2), fill=WHITE)
        draw.point((cx, cy - half_h - 2), fill=VIOLET_HI)


def glyph_lines(kind: int, cx: int, cy: int, compact: bool) -> list[list[tuple[int, int]]]:
    s = 0 if compact else 1
    if kind == 0:  # Raidho-like: spine, crown, and throwing leg.
        return [
            [(cx - 2, cy - 4 + s), (cx - 2, cy + 4 - s)],
            [(cx - 2, cy - 3), (cx + 2, cy - 1), (cx - 2, cy + 1)],
            [(cx - 1, cy + 1), (cx + 2, cy + 4 - s)],
        ]
    if kind == 1:  # Kenaz-like open angle.
        return [
            [(cx + 2, cy - 4 + s), (cx - 2, cy), (cx + 2, cy + 4 - s)],
        ]
    return [  # Othala-like diamond with two feet.
        [(cx, cy - 4 + s), (cx + 3, cy), (cx, cy + 3 - s), (cx - 3, cy), (cx, cy - 4 + s)],
        [(cx - 1, cy + 3 - s), (cx - 3, cy + 5 - s)],
        [(cx + 1, cy + 3 - s), (cx + 3, cy + 5 - s)],
    ]


def draw_rune(image: Image.Image, cx: int, cy: int, kind: int, compact: bool = False) -> None:
    draw = ImageDraw.Draw(image)
    rx, ry = (4, 5) if compact else (5, 7)
    outline = [
        (cx, cy - ry), (cx + rx - 1, cy - ry + 2), (cx + rx, cy + 2),
        (cx + 2, cy + ry), (cx - 2, cy + ry), (cx - rx, cy + 2),
        (cx - rx + 1, cy - ry + 2),
    ]
    draw.point((cx - rx - 2, cy), fill=VIOLET_DARK)
    draw.point((cx + rx + 2, cy - 1), fill=VIOLET_DARK)
    draw.point((cx, cy - ry - 2), fill=VIOLET)
    draw.polygon(outline, fill=INKS[kind], outline=VIOLET_HI)
    draw.point((cx - rx, cy - 2), fill=WHITE)
    draw.point((cx + rx - 1, cy + 2), fill=VIOLET)
    for line in glyph_lines(kind, cx, cy, compact):
        draw.line(line, fill=WHITE, width=1)
        if not compact:
            for x, y in line[::2]:
                draw.point((x + 1, y), fill=VIOLET_HI)


def draw_flight_sparks(image: Image.Image, cx: int, cy: int, step: int) -> None:
    draw = ImageDraw.Draw(image)
    draw.point((cx - 7, cy + (step % 2)), fill=VIOLET)
    if step >= 2:
        draw.point((cx - 11, cy + 2), fill=VIOLET_DARK)
    if step >= 4:
        draw.point((cx - 14, cy - 2), fill=VIOLET_HI)


def build() -> tuple[list[Image.Image], list[Image.Image], list[Image.Image]]:
    body = load_frames(SOURCE)
    base = body[0]
    enter: list[Image.Image] = []
    for phase in (0.0, 0.18, 0.38, 0.65, 0.86, 1.0):
        frame = base.copy()
        draw_portal(frame, phase)
        enter.append(frame)

    positions = {
        2: (72, 68),
        3: (78, 64),
        4: (84, 60),
        5: (91, 57),
        6: (98, 56),
        7: (105, 57),
        8: (112, 58),
    }
    loop: list[Image.Image] = []
    for kind in range(3):
        for index, body_frame in enumerate(body):
            frame = body_frame.copy()
            draw_portal(frame, 1.0, flash=1 if index in (8, 9) else 0)
            if index in positions:
                x, y = positions[index]
                draw_flight_sparks(frame, x, y, index - 2)
                draw_rune(frame, x, y, kind, compact=index == 8)
            elif index == 1:
                # First light over the fingers: clearly a forming token, not a line.
                draw_rune(frame, 68, 70, kind, compact=True)
            loop.append(frame)

    exit_frames: list[Image.Image] = []
    for phase in (1.0, 0.82, 0.58, 0.34, 0.14, 0.0):
        frame = base.copy()
        draw_portal(frame, phase)
        exit_frames.append(frame)
    return enter, loop, exit_frames


def save_review(enter: list[Image.Image], loop: list[Image.Image], exit_frames: list[Image.Image]) -> None:
    REVIEW.mkdir(parents=True, exist_ok=True)
    sequence = enter + loop + exit_frames
    gif_frames = [frame.resize((384, 384), Image.Resampling.NEAREST) for frame in sequence]
    gif_frames[0].save(
        REVIEW / "kael-typing-v4-preview.gif",
        save_all=True,
        append_images=gif_frames[1:],
        duration=120,
        loop=0,
        disposal=2,
    )

    # The decisive beats: portal open, then form/release/flight/absorb per rune.
    selected = enter + [loop[kind * 17 + index] for kind in range(3) for index in (1, 4, 6, 7, 8, 9)] + exit_frames
    scale, columns, pad, label = 4, 5, 10, 20
    tile_w = tile_h = 128 * scale
    rows = (len(selected) + columns - 1) // columns
    sheet = Image.new(
        "RGBA",
        (columns * (tile_w + pad) + pad, rows * (tile_h + label + pad) + pad),
        (24, 24, 27, 255),
    )
    draw = ImageDraw.Draw(sheet)
    for index, frame in enumerate(selected):
        x = pad + (index % columns) * (tile_w + pad)
        y = pad + (index // columns) * (tile_h + label + pad)
        tile = frame.resize((tile_w, tile_h), Image.Resampling.NEAREST)
        sheet.alpha_composite(tile, (x, y + label))
        draw.text((x, y), f"beat {index}", fill=WHITE)
    sheet.save(REVIEW / "kael-typing-v4-contact.png")


def main() -> None:
    enter, loop, exit_frames = build()
    save_frames(OUTPUT / "enter", enter)
    save_frames(OUTPUT / "loop", loop)
    save_frames(OUTPUT / "exit", exit_frames)
    save_review(enter, loop, exit_frames)
    print(f"Kael typing v4: enter={len(enter)} loop={len(loop)} exit={len(exit_frames)}")


if __name__ == "__main__":
    main()
