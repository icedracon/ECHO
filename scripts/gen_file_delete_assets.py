"""Compose and validate the deterministic file-deletion reaction pack.

PixelLab owns character acting only. Props, rifts, fire, impacts and the ranged
slash are drawn here so their shape and contact frames cannot drift between
generations. Rejected source folders stay under _candidates and are never read.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

from PIL import Image, ImageChops, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
PIXEL = ROOT / "public" / "pixel"
CANDIDATES = PIXEL / "_candidates" / "file-delete-v2"
REVIEW = ROOT / "assets-src" / "wip" / "runtime-review"
SIZE = 128

BLUE = (42, 105, 255, 255)
BLUE_HI = (178, 224, 255, 255)
RED = (245, 34, 71, 255)
RED_HI = (255, 151, 166, 255)
VOID = (3, 2, 11, 255)
VIOLET = (151, 39, 255, 255)
VIOLET_HI = (229, 174, 255, 255)
YELLOW = (255, 205, 0, 255)
YELLOW_HI = (255, 235, 104, 255)
GOLD = (232, 164, 0, 255)
PAPER = (239, 239, 235, 255)


def load_frames(folder: Path) -> list[Image.Image]:
    paths = sorted(folder.glob("frame_*.png"), key=lambda path: int(path.stem.split("_")[-1]))
    if not paths:
        raise FileNotFoundError(f"no frames in {folder}")
    return [Image.open(path).convert("RGBA") for path in paths]


def canvas(frame: Image.Image) -> Image.Image:
    frame = frame.convert("RGBA")
    if frame.size == (SIZE, SIZE):
        return frame.copy()
    result = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    x = (SIZE - frame.width) // 2
    y = SIZE - frame.height
    result.alpha_composite(frame, (x, y))
    return result


def save_clip(name: str, images: Iterable[Image.Image]) -> list[Image.Image]:
    output = PIXEL.joinpath(*name.split("/"))
    output.mkdir(parents=True, exist_ok=True)
    for old in output.glob("frame_*.png"):
        old.unlink()
    saved = [canvas(image) for image in images]
    for index, image in enumerate(saved):
        image.save(output / f"frame_{index}.png")
    return saved


def portal_points(cx: int, cy: int, half_w: int, half_h: int) -> list[tuple[int, int]]:
    return [
        (cx, cy - half_h),
        (cx + 3, cy - half_h + 2),
        (cx + half_w, cy - half_h // 2),
        (cx + half_w - 1, cy - 2),
        (cx + half_w + 1, cy + 4),
        (cx + half_w // 2, cy + half_h - 2),
        (cx, cy + half_h),
        (cx - 3, cy + half_h - 1),
        (cx - half_w, cy + half_h // 2),
        (cx - half_w + 1, cy),
        (cx - half_w - 1, cy - half_h // 3),
        (cx - half_w // 2, cy - half_h + 2),
    ]


def draw_portal(image: Image.Image, cx: int, cy: int, phase: float) -> None:
    if phase <= 0:
        return
    phase = max(0.1, min(1.0, phase))
    half_w = max(2, round(8 * phase))
    half_h = max(4, round(20 * phase))
    points = portal_points(cx, cy, half_w, half_h)
    closed = points + [points[0]]
    draw = ImageDraw.Draw(image)
    draw.polygon(points, fill=VOID)
    draw.line(closed, fill=BLUE, width=2)
    draw.line(points[6:12], fill=RED, width=1)
    for start in (0, 3, 6, 9):
        draw.line(
            [points[start], points[(start + 1) % len(points)]],
            fill=RED_HI if start in (3, 9) else BLUE_HI,
            width=1,
        )
    for x, y in points[::2]:
        draw.point((x + (1 if x < cx else -1), y), fill=RED if y > cy else BLUE)
    draw.point((cx - half_w - 2, cy - 5), fill=BLUE_HI)
    draw.point((cx + half_w + 2, cy + 6), fill=RED)


def folder_colors(burn: float) -> tuple[tuple[int, int, int, int], ...]:
    burn = max(0.0, min(1.0, burn))

    def mix(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
        return tuple(round(x + (y - x) * burn) for x, y in zip(a, b))  # type: ignore[return-value]

    return mix(GOLD, (38, 28, 36, 255)), mix(YELLOW, (20, 17, 24, 255)), mix(YELLOW_HI, (88, 58, 74, 255))


def draw_folder(
    image: Image.Image,
    x: int,
    y: int,
    *,
    damage: int = 0,
    burn: float = 0.0,
) -> None:
    back_color, front_color, edge_color = folder_colors(burn)
    draw = ImageDraw.Draw(image)
    tab = [(x + 1, y), (x + 8, y), (x + 10, y + 4), (x + 18, y + 4)]
    back = [(x, y + 3), (x + 18, y + 3), (x + 17, y + 14), (x + 1, y + 14)]
    front = [(x, y + 7), (x + 7, y + 7), (x + 10, y + 5), (x + 18, y + 5), (x + 16, y + 14), (x + 1, y + 14)]
    draw.polygon(tab, fill=back_color, outline=edge_color)
    draw.polygon(back, fill=back_color, outline=edge_color)
    if burn < 0.72:
        draw.rectangle((x + 3, y + 5, x + 15, y + 9), fill=PAPER)
    draw.polygon(front, fill=front_color, outline=edge_color)
    if damage >= 1:
        draw.line((x + 9, y + 5, x + 8, y + 10), fill=BLUE_HI, width=1)
    if damage >= 2:
        draw.line((x + 8, y + 10, x + 12, y + 14), fill=RED, width=1)


def draw_folder_halves(image: Image.Image, step: int) -> None:
    draw = ImageDraw.Draw(image)
    fall = step * step * 2
    left_x, right_x = 108 - step * 3, 113 + step * 2
    y = 57 + fall
    draw.polygon(
        [(left_x, y), (left_x + 7, y + 2), (left_x + 5, y + 12), (left_x - 1, y + 9)],
        fill=GOLD,
        outline=YELLOW_HI,
    )
    draw.polygon(
        [(right_x, y - 2), (right_x + 8, y), (right_x + 7, y + 10), (right_x + 1, y + 8)],
        fill=YELLOW,
        outline=YELLOW_HI,
    )
    draw.line((left_x + 5, y + 2, left_x + 3, y + 9), fill=BLUE_HI)
    draw.line((right_x + 1, y, right_x + 5, y + 8), fill=RED)


def draw_muzzle_flash(image: Image.Image, x: int, y: int) -> None:
    draw = ImageDraw.Draw(image)
    draw.polygon([(x, y), (x + 7, y - 3), (x + 5, y), (x + 8, y + 3), (x + 1, y + 2)], fill=RED_HI)
    draw.line((x, y, x + 5, y), fill=BLUE_HI, width=1)


def clean_generated_muzzle(image: Image.Image) -> None:
    pixels = image.load()
    for y in range(42, 70):
        for x in range(90, 108):
            r, g, b, a = pixels[x, y]
            if a and r > 190 and g > 120 and b < 90:
                pixels[x, y] = (0, 0, 0, 0)


def draw_energy_cut(image: Image.Image, step: int) -> None:
    x = 87 + step * 7
    y = 70 - step * 4
    draw = ImageDraw.Draw(image)
    red_path = [(x - 7, y + 9), (x, y + 5), (x + 7, y - 5)]
    blue_path = [(x - 5, y + 10), (x + 2, y + 4), (x + 9, y - 6)]
    draw.line(red_path, fill=RED, width=3)
    draw.line(blue_path, fill=BLUE_HI, width=1)
    draw.point((x - 9, y + 10), fill=BLUE)
    draw.point((x + 10, y - 7), fill=RED_HI)


def draw_impact(image: Image.Image, x: int, y: int) -> None:
    draw = ImageDraw.Draw(image)
    draw.line((x - 7, y, x + 8, y), fill=BLUE_HI, width=2)
    draw.line((x, y - 8, x, y + 8), fill=RED_HI, width=2)
    draw.line((x - 5, y - 5, x + 6, y + 6), fill=RED)
    draw.line((x - 5, y + 5, x + 6, y - 6), fill=BLUE)


def draw_hand_flame(image: Image.Image, x: int, y: int, strength: int) -> None:
    if strength <= 0:
        return
    draw = ImageDraw.Draw(image)
    height = 8 + strength * 3
    draw.polygon(
        [(x - 3, y + 8), (x, y + 2), (x + 2, y - height), (x + 5, y + 1), (x + 9, y - height // 2), (x + 12, y + 8)],
        fill=VIOLET,
    )
    draw.line((x + 2, y + 6, x + 5, y - height + 3, x + 8, y + 5), fill=VIOLET_HI, width=2)
    draw.point((x - 5, y - 2), fill=BLUE_HI)
    draw.point((x + 14, y - 5), fill=RED_HI)


def draw_smoke_and_ash(image: Image.Image, x: int, y: int, step: int) -> None:
    draw = ImageDraw.Draw(image)
    smoke = (176, 167, 190, max(60, 220 - step * 24))
    draw.line([(x, y), (x + 3, y - 6 - step), (x, y - 11 - step)], fill=smoke, width=2)
    for index in range(max(1, 5 - step // 2)):
        draw.point((x - 5 + index * 3, y + 4 + (index % 2) * 2), fill=(65, 55, 72, 220))


def draw_bin(image: Image.Image, x: int, y: int) -> None:
    draw = ImageDraw.Draw(image)
    draw.rectangle((x + 2, y + 4, x + 16, y + 20), fill=(44, 49, 60, 255), outline=(150, 158, 175, 255))
    draw.line((x, y + 3, x + 18, y + 3), fill=(195, 201, 214, 255), width=2)
    draw.line((x + 5, y + 8, x + 5, y + 17), fill=(89, 96, 111, 255))
    draw.line((x + 9, y + 8, x + 9, y + 17), fill=(89, 96, 111, 255))
    draw.line((x + 13, y + 8, x + 13, y + 17), fill=(89, 96, 111, 255))


def draw_stone(image: Image.Image, x: int, y: int) -> None:
    draw = ImageDraw.Draw(image)
    draw.polygon([(x, y + 3), (x + 2, y), (x + 8, y), (x + 10, y + 3), (x + 8, y + 6), (x + 1, y + 6)], fill=(83, 85, 98, 255), outline=(148, 151, 165, 255))


def build_dante_shoot() -> list[Image.Image]:
    body = [canvas(frame) for frame in load_frames(CANDIDATES / "dante_delete_shoot_body_a")]
    idle = canvas(Image.open(PIXEL / "dante_idle.png"))
    body[0] = idle.copy()
    body[-1] = idle.copy()
    positions = {1: (104, 122), 2: (104, 106), 3: (104, 86), 4: (104, 67), 5: (104, 53), 6: (104, 49)}
    result = []
    for index, source in enumerate(body):
        frame = source.copy()
        clean_generated_muzzle(frame)
        if index in positions:
            draw_folder(frame, *positions[index])
        elif index >= 7:
            draw_folder(frame, 104, 51, damage=1)
        if index == 7:
            draw_muzzle_flash(frame, 94, 57)
        result.append(frame)
    return result


def build_dante_draw() -> list[Image.Image]:
    body = [canvas(frame) for frame in load_frames(CANDIDATES / "dante_delete_sworddraw_body_a")]
    body[0] = canvas(Image.open(PIXEL / "dante_idle.png"))
    result = []
    for source in body:
        frame = source.copy()
        draw_folder(frame, 104, 51, damage=1)
        result.append(frame)
    return result


def build_dante_cut() -> list[Image.Image]:
    body = [canvas(frame) for frame in load_frames(CANDIDATES / "dante_delete_rangedcut_body_a")]
    body[0] = canvas(load_frames(CANDIDATES / "dante_delete_sworddraw_body_a")[-1])
    body[-1] = canvas(Image.open(PIXEL / "dante_idle.png"))
    result = []
    for index, source in enumerate(body):
        frame = source.copy()
        if index <= 7:
            draw_folder(frame, 104, 51, damage=2 if index >= 5 else 1)
        if 5 <= index <= 8:
            draw_energy_cut(frame, index - 5)
        if index == 8:
            draw_impact(frame, 112, 58)
        elif 9 <= index <= 14:
            draw_folder_halves(frame, index - 8)
        result.append(frame)
    return result


def build_corvin_summon() -> list[Image.Image]:
    body = [canvas(frame) for frame in load_frames(CANDIDATES / "corvin_delete_summon_body_b")]
    body[0] = canvas(Image.open(PIXEL / "corvin" / "idle" / "frame_0.png"))
    phases = [0.0, 0.25, 0.5, 0.78, 1.0, 1.0, 1.0, 0.82, 0.58, 0.3, 0.1, 0.0, 0.0]
    travel = {4: (106, 54), 5: (100, 55), 6: (94, 56), 7: (88, 57), 8: (83, 58), 9: (79, 59), 10: (77, 59), 11: (77, 59), 12: (77, 59)}
    result = []
    for index, source in enumerate(body):
        frame = source.copy()
        draw_portal(frame, 114, 61, phases[index])
        if index in travel:
            draw_folder(frame, *travel[index])
        result.append(frame)
    return result


def build_corvin_burn() -> list[Image.Image]:
    body = [canvas(frame) for frame in load_frames(CANDIDATES / "corvin_delete_burn_body_a")]
    body[0] = canvas(load_frames(CANDIDATES / "corvin_delete_summon_body_b")[-1])
    body[-1] = canvas(Image.open(PIXEL / "corvin" / "idle" / "frame_0.png"))
    result = []
    for index, source in enumerate(body):
        frame = source.copy()
        if index <= 10:
            burn = max(0.0, (index - 3) / 7)
            draw_folder(frame, 77, 59, burn=burn)
            draw_hand_flame(frame, 79, 62, min(4, max(0, index - 2)))
        if 9 <= index <= 14:
            draw_smoke_and_ash(frame, 86, 66, index - 9)
        result.append(frame)
    return result


def build_dante_flick(empty_bin: bool = False) -> list[Image.Image]:
    source = [canvas(frame) for frame in load_frames(PIXEL / "_candidates" / "file-delete" / "dante_flick")]
    body = source + [source[-1].copy() for _ in range(4)]
    result = []
    positions = [(45, 56), (44, 54), (42, 53), (39, 52), (34, 55), (26, 62), (16, 72), (7, 86), (1, 104)]
    for index, source_frame in enumerate(body):
        frame = source_frame.copy()
        if empty_bin:
            draw_bin(frame, 4, 104)
            if index < len(positions):
                x, y = positions[index]
                draw_folder(frame, x, min(y, 101))
        elif index < len(positions):
            draw_folder(frame, *positions[index])
        result.append(frame)
    return result


def build_corvin_lastrites() -> list[Image.Image]:
    return [canvas(frame) for frame in load_frames(PIXEL / "_candidates" / "file-delete" / "corvin_lastrites")]


def build_corvin_cairnstone() -> list[Image.Image]:
    source = [canvas(frame) for frame in load_frames(PIXEL / "corvin" / "cairn")]
    body = source + [frame.copy() for frame in reversed(source[:-1])]
    result = []
    for index, source_frame in enumerate(body):
        frame = source_frame.copy()
        if 4 <= index <= 8:
            draw_stone(frame, 48 - (index - 4) * 7, 94 - (index - 4) * 3)
        if index >= 8:
            draw_stone(frame, 17, 77)
        result.append(frame)
    return result


def contact_sheet(name: str, images: list[Image.Image]) -> None:
    columns, scale, pad, label = 5, 3, 8, 18
    tile = SIZE * scale
    rows = (len(images) + columns - 1) // columns
    sheet = Image.new("RGBA", (columns * (tile + pad) + pad, rows * (tile + label + pad) + pad), (24, 24, 27, 255))
    draw = ImageDraw.Draw(sheet)
    for index, frame in enumerate(images):
        x = pad + (index % columns) * (tile + pad)
        y = pad + (index // columns) * (tile + label + pad)
        sheet.alpha_composite(frame.resize((tile, tile), Image.Resampling.NEAREST), (x, y + label))
        draw.text((x, y), f"frame {index}", fill=(238, 238, 238, 255))
    REVIEW.mkdir(parents=True, exist_ok=True)
    safe_name = name.replace("/", "-")
    sheet.save(REVIEW / f"file-delete-{safe_name}-contact.png")
    preview = [frame.resize((SIZE * 3, SIZE * 3), Image.Resampling.NEAREST) for frame in images]
    preview[0].save(
        REVIEW / f"file-delete-{safe_name}-preview.gif",
        save_all=True,
        append_images=preview[1:],
        duration=130,
        loop=0,
        disposal=2,
    )


def exact(left: Image.Image, right: Image.Image, label: str) -> None:
    if ImageChops.difference(left, right).getbbox() is not None:
        raise ValueError(f"contact mismatch: {label}")


def main() -> None:
    clips = {
        "d_delete_shoot": build_dante_shoot(),
        "d_delete_sworddraw": build_dante_draw(),
        "d_delete_rangedcut": build_dante_cut(),
        "d_delete_flick": build_dante_flick(),
        "d_emptybin": build_dante_flick(empty_bin=True),
        "corvin/delete_summon": build_corvin_summon(),
        "corvin/delete_burn": build_corvin_burn(),
        "corvin/delete_lastrites": build_corvin_lastrites(),
        "corvin/delete_cairnstone": build_corvin_cairnstone(),
    }
    for name, images in clips.items():
        if not images or any(image.size != (SIZE, SIZE) for image in images):
            raise ValueError(f"{name}: every frame must be {SIZE}x{SIZE}")

    exact(clips["d_delete_shoot"][-1], clips["d_delete_sworddraw"][0], "Dante shoot -> draw")
    exact(clips["d_delete_sworddraw"][-1], clips["d_delete_rangedcut"][0], "Dante draw -> cut")
    exact(clips["corvin/delete_summon"][-1], clips["corvin/delete_burn"][0], "Corvin summon -> burn")

    for name, images in clips.items():
        saved = save_clip(name, images)
        contact_sheet(name, saved)
        print(f"{name}: {len(saved)} frames, 128x128")


if __name__ == "__main__":
    main()
