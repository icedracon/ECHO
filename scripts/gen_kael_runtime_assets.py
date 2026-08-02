"""Publish approved Kael body acting and deterministic Abyss effects."""

from __future__ import annotations

import shutil
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
PIXEL = ROOT / "public" / "pixel"
KAEL = PIXEL / "kael"
CAND = PIXEL / "_candidates"
REVIEW = ROOT / "assets-src" / "wip" / "runtime-review"

VOID = (2, 1, 7, 255)
VIOLET_DARK = (56, 15, 92, 255)
VIOLET = (139, 39, 241, 255)
VIOLET_HI = (221, 165, 255, 255)
CRIMSON = (206, 35, 72, 255)
CYAN = (88, 203, 255, 255)
SILVER = (219, 225, 238, 255)
WHITE = (250, 246, 255, 255)


def frame_paths(folder: Path) -> list[Path]:
    return sorted(folder.glob("frame_*.png"), key=lambda p: int(p.stem.split("_")[-1]))


def load_frames(folder: Path) -> list[Image.Image]:
    paths = frame_paths(folder)
    if not paths:
        raise FileNotFoundError(folder)
    return [Image.open(path).convert("RGBA") for path in paths]


def save_frames(folder: Path, frames: list[Image.Image]) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for old in frame_paths(folder):
        old.unlink()
    for index, frame in enumerate(frames):
        if frame.size != (128, 128):
            raise ValueError(f"{folder.name}[{index}] is {frame.size}")
        frame.save(folder / f"frame_{index}.png")


def ensure_backup(name: str) -> Path:
    source = KAEL / name
    backup = CAND / f"kael_{name}_body_original"
    if not backup.exists():
        backup.mkdir(parents=True)
        for path in frame_paths(source):
            shutil.copy2(path, backup / path.name)
    return backup


def same_pixels(a: Image.Image, b: Image.Image) -> bool:
    return a.tobytes() == b.tobytes()


def require_contact(a: Image.Image, b: Image.Image, label: str) -> None:
    if not same_pixels(a, b):
        raise ValueError(f"disconnected Kael contact: {label}")


def portalize(frame: Image.Image) -> Image.Image:
    out = frame.copy()
    px = out.load()
    mask: set[tuple[int, int]] = set()
    for y in range(128):
        for x in range(128):
            if px[x, y] == (77, 67, 66, 255):
                mask.add((x, y))
                px[x, y] = VOID
    if len(mask) < 20:
        return out

    draw = ImageDraw.Draw(out)
    edge = []
    for x, y in mask:
        if any((x + dx, y + dy) not in mask for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            edge.append((x, y))
    for index, (x, y) in enumerate(sorted(edge)):
        draw.point((x, y), fill=VIOLET_HI if index % 7 == 0 else VIOLET)
        if index % 5 == 0:
            ox = x + (1 if x >= 48 else -1)
            if 0 <= ox < 128:
                draw.point((ox, y), fill=VIOLET_DARK)
    return out


def draw_search_symbol(frame: Image.Image, index: int, count: int) -> None:
    if index < 5 or index > count - 4:
        return
    t = (index - 5) / max(1, count - 8)
    cx = round(118 - 16 * t)
    cy = round(53 + 5 * t)
    draw = ImageDraw.Draw(frame)
    draw.line([(cx, cy - 4), (cx + 3, cy), (cx, cy + 4), (cx - 3, cy), (cx, cy - 4)], fill=VIOLET_HI)
    draw.line([(cx, cy - 2), (cx, cy + 2)], fill=WHITE)
    draw.line([(cx, cy + 2), (cx + 2, cy + 4)], fill=WHITE)
    draw.point((cx - 5, cy + 1), fill=VIOLET)


def draw_streak_ring(frame: Image.Image, index: int, count: int) -> None:
    if index == 0 or index == count - 1:
        return
    peak = 1.0 - abs((index / (count - 1)) * 2 - 1)
    draw = ImageDraw.Draw(frame)
    box = (23, 20, 112, 116)
    sweep = max(25, round(250 * peak))
    draw.arc(box, start=205 - sweep // 2, end=205 + sweep // 2, fill=CRIMSON, width=2)
    draw.arc((25, 22, 110, 114), start=28 - sweep // 3, end=28 + sweep // 2, fill=CYAN, width=1)
    if peak > 0.55:
        draw.line([(30, 100), (20, 106), (13, 109)], fill=CRIMSON, width=2)
        draw.line([(31, 98), (21, 102), (15, 103)], fill=CYAN)


CRACK = [(119, 23), (114, 34), (120, 43), (112, 54), (118, 64), (111, 76), (116, 87), (109, 101)]


def crack_segment(amount: float) -> list[tuple[int, int]]:
    take = max(2, min(len(CRACK), round(2 + amount * (len(CRACK) - 2))))
    return CRACK[:take]


def draw_crack(frame: Image.Image, amount: float, stitches: int = 0, seal: float = 0.0) -> None:
    if amount <= 0:
        return
    points = crack_segment(amount)
    draw = ImageDraw.Draw(frame)
    draw.line(points, fill=VIOLET_DARK, width=4)
    draw.line(points, fill=VOID, width=2)
    for i, (x, y) in enumerate(points[1:-1], 1):
        if i % 2:
            draw.point((x + 2, y - 1), fill=VIOLET)
    for i in range(min(stitches, max(0, len(points) - 2))):
        x, y = points[i + 1]
        draw.line([(x - 4, y - 3), (x + 4, y + 3)], fill=SILVER)
        draw.line([(x + 4, y - 3), (x - 4, y + 3)], fill=WHITE)
    if seal > 0:
        radius = max(2, round(6 * seal))
        draw.ellipse((115 - radius, 60 - radius, 115 + radius, 60 + radius), outline=CRIMSON, width=2)
        draw.line([(111, 60), (119, 60)], fill=VIOLET_HI)
        draw.line([(115, 56), (115, 64)], fill=VIOLET_HI)


def compose_voidstitch() -> None:
    alarm = load_frames(ensure_backup("voidstitch_alarm"))
    pull = load_frames(ensure_backup("voidstitch_pull"))
    seal = load_frames(ensure_backup("voidstitch_seal"))
    for i, frame in enumerate(alarm):
        draw_crack(frame, max(0.0, (i - 2) / (len(alarm) - 3)))
    for i, frame in enumerate(pull):
        draw_crack(frame, 1.0, round((i / (len(pull) - 1)) * 6))
    for i, frame in enumerate(seal):
        t = i / (len(seal) - 1)
        draw_crack(frame, max(0.0, 1.0 - t), round(6 * (1.0 - t)), 1.0 - abs(t * 2 - 1))
    require_contact(alarm[-1], pull[0], "voidstitch alarm/pull")
    require_contact(pull[-1], seal[0], "voidstitch pull/seal")
    save_frames(KAEL / "voidstitch_alarm", alarm)
    save_frames(KAEL / "voidstitch_pull", pull)
    save_frames(KAEL / "voidstitch_seal", seal)


def draw_night(frame: Image.Image, phase: float, memory: float = 0.0) -> None:
    if phase <= 0:
        return
    phase = min(1.0, max(0.08, phase))
    draw = ImageDraw.Draw(frame)
    cx, cy = 114, 27
    hw = max(1, round(6 * phase))
    hh = max(3, round(14 * phase))
    points = [(cx, cy - hh), (cx + hw, cy - hh // 2), (cx + hw + 1, cy + 3),
              (cx + 2, cy + hh), (cx - hw, cy + hh // 2), (cx - hw - 1, cy - 3)]
    draw.polygon(points, fill=VOID)
    draw.line(points + [points[0]], fill=VIOLET_DARK, width=2)
    draw.line([points[0], points[1]], fill=VIOLET_HI)
    draw.point((cx - hw - 2, cy + 2), fill=VIOLET)
    # Warm light belongs to the open mechanical palm, not the whole room.
    if phase > 0.55:
        draw.point((99, 36), fill=VIOLET_HI)
        draw.point((100, 37), fill=WHITE)
        draw.point((102, 38), fill=VIOLET)
    if memory > 0.2:
        draw.line([(cx, cy - 5), (cx, cy + 3)], fill=(163, 151, 181, 255))
        draw.point((cx - 1, cy - 6), fill=SILVER)
        draw.line([(cx, cy), (cx - 2, cy + 5)], fill=(111, 102, 128, 255))


def publish_night() -> tuple[list[Image.Image], list[Image.Image], list[Image.Image]]:
    enter = load_frames(CAND / "kael_night_enter_v3_a")
    loop = load_frames(CAND / "kael_night_loop_body_v3_a")
    glance = load_frames(CAND / "kael_night_glance_body_v3_a")
    loop[0] = enter[-1].copy()
    loop[-1] = enter[-1].copy()
    glance[0] = enter[-1].copy()
    glance[-1] = enter[-1].copy()
    for i, frame in enumerate(enter):
        draw_night(frame, i / (len(enter) - 1))
    for frame in loop:
        draw_night(frame, 1.0)
    for i, frame in enumerate(glance):
        memory = 1.0 - abs((i / (len(glance) - 1)) * 2 - 1)
        draw_night(frame, 1.0, memory)
    require_contact(enter[-1], loop[0], "night enter/loop")
    require_contact(loop[0], glance[0], "night loop/glance start")
    require_contact(loop[0], glance[-1], "night glance/loop end")
    save_frames(KAEL / "night_enter_v3", enter)
    save_frames(KAEL / "night_loop_v3", loop)
    save_frames(KAEL / "night_glance_v3", glance)
    return enter, loop, glance


def publish_overload() -> tuple[list[Image.Image], list[Image.Image]]:
    enter = load_frames(CAND / "kael_overload_enter_v3_b")
    for i, frame in enumerate(enter):
        t = i / (len(enter) - 1)
        energy = max(0.0, 1.0 - abs((t - 0.48) / 0.48))
        if energy > 0.18:
            draw = ImageDraw.Draw(frame)
            x = round(79 + 7 * t)
            y = round(62 + 18 * t)
            draw.line([(x, y - 7), (x + 3, y - 2), (x, y + 4)], fill=VIOLET_HI)
            draw.point((x + 5, y), fill=WHITE)
            if energy > 0.6:
                draw.point((x - 3, y + 5), fill=VIOLET)
    exit_frames = [frame.copy() for frame in reversed(load_frames(CAND / "kael_overload_enter_v3_b"))]
    require_contact(enter[-1], exit_frames[0], "overload settle/exit")
    save_frames(KAEL / "overload_enter_v3", enter)
    save_frames(KAEL / "overload_exit_v3", exit_frames)
    return enter, exit_frames


def publish_swordplant() -> tuple[list[Image.Image], list[Image.Image]]:
    setup = load_frames(CAND / "kael_swordplant_enter_v3_b")
    drive = load_frames(CAND / "kael_swordplant_drive_v3_c")
    drive[0] = setup[12].copy()
    require_contact(setup[12], drive[0], "swordplant setup/drive")
    enter = [frame.copy() for frame in setup[:13]] + [frame.copy() for frame in drive[1:]]
    hold_all = load_frames(CAND / "kael_swordplant_hold_v3_a")
    hold_all[0] = enter[-1].copy()
    hold_all[-1] = enter[-1].copy()
    require_contact(enter[-1], hold_all[0], "swordplant enter/hold")
    require_contact(hold_all[0], hold_all[-1], "swordplant hold loop")
    hold = [frame.copy() for frame in hold_all]
    save_frames(KAEL / "swordplant_enter_v3", enter)
    save_frames(KAEL / "swordplant_hold_v3", hold)
    return enter, hold


def publish_combat() -> dict[str, list[Image.Image]]:
    clips = {
        "combat_grip_v3": load_frames(CAND / "kael_combat_grip_v3_a"),
        "combat_glance_v3": load_frames(CAND / "kael_combat_glance_v3_a"),
    }
    base = load_frames(KAEL / "combat_idle_v2")[0]
    for name, frames in clips.items():
        frames[0] = base.copy()
        frames[-1] = base.copy()
        require_contact(base, frames[0], f"combat idle/{name}")
        require_contact(base, frames[-1], f"{name}/combat idle")
        save_frames(KAEL / name, frames)
        shutil.copy2(KAEL / "combat_idle_v2" / "frame_0.png", KAEL / name / "frame_0.png")
        shutil.copy2(KAEL / "combat_idle_v2" / "frame_0.png", KAEL / name / f"frame_{len(frames) - 1}.png")

    idle = load_frames(KAEL / "combat_idle_v2")
    runes = [base.copy()] + [frame.copy() for frame in idle[1:-1]] + [base.copy()]
    for i, frame in enumerate(runes[1:-1], 1):
        draw = ImageDraw.Draw(frame)
        cx, cy = 68 + (i % 2), 58 - i // 3
        draw.line([(cx, cy - 3), (cx + 3, cy), (cx, cy + 3), (cx - 3, cy), (cx, cy - 3)], fill=VIOLET_HI)
        draw.point((cx, cy), fill=WHITE)
    clips["combat_runes_v3"] = runes
    save_frames(KAEL / "combat_runes_v3", runes)
    shutil.copy2(KAEL / "combat_idle_v2" / "frame_0.png", KAEL / "combat_runes_v3" / "frame_0.png")
    shutil.copy2(KAEL / "combat_idle_v2" / "frame_0.png", KAEL / "combat_runes_v3" / "frame_8.png")
    return clips


def publish_effect_repairs() -> dict[str, list[Image.Image]]:
    leave = [portalize(frame) for frame in load_frames(ensure_backup("leave_v2"))]
    ret = [portalize(frame) for frame in load_frames(ensure_backup("return_v2"))]
    require_contact(leave[-1], ret[0], "leave/return portal")
    save_frames(KAEL / "leave_v2", leave)
    save_frames(KAEL / "return_v2", ret)

    search = load_frames(ensure_backup("search_v2"))
    for i, frame in enumerate(search):
        draw_search_symbol(frame, i, len(search))
    save_frames(KAEL / "search_v2", search)

    streak = load_frames(ensure_backup("streak_v2"))
    for i, frame in enumerate(streak):
        draw_streak_ring(frame, i, len(streak))
    save_frames(KAEL / "streak_v2", streak)
    compose_voidstitch()
    return {"portal": leave + ret, "search": search, "streak": streak}


def repair_organ_edges() -> list[Image.Image]:
    repaired: list[Image.Image] = []
    for name in ("organ_platypus_v2", "organ_fade_v3"):
        frames = load_frames(ensure_backup(name))
        for frame in frames:
            # The generated violet pipe glow touched y=0 in a handful of frames.
            # A transparent one-pixel breathing margin removes the clipped cap;
            # grounded boots/pedals at y=127 are deliberately preserved.
            for x in range(128):
                frame.putpixel((x, 0), (0, 0, 0, 0))
        save_frames(KAEL / name, frames)
        repaired.extend(frames)
    return repaired


def review(name: str, frames: list[Image.Image], duration: int = 150) -> None:
    REVIEW.mkdir(parents=True, exist_ok=True)
    selected = frames if len(frames) <= 25 else frames[:: max(1, len(frames) // 24)]
    scale, cols, pad, label = 3, 5, 8, 17
    tw = th = 128 * scale
    rows = (len(selected) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * (tw + pad) + pad, rows * (th + label + pad) + pad), (24, 24, 27, 255))
    draw = ImageDraw.Draw(sheet)
    for i, frame in enumerate(selected):
        x = pad + (i % cols) * (tw + pad)
        y = pad + (i // cols) * (th + label + pad)
        sheet.alpha_composite(frame.resize((tw, th), Image.Resampling.NEAREST), (x, y + label))
        draw.text((x, y), f"frame {i}", fill=WHITE)
    sheet.save(REVIEW / f"kael-{name}-contact.png")

    gif = [frame.resize((384, 384), Image.Resampling.NEAREST) for frame in frames]
    gif[0].save(REVIEW / f"kael-{name}-preview.gif", save_all=True, append_images=gif[1:], duration=duration, loop=0, disposal=2)


def main() -> None:
    effects = publish_effect_repairs()
    organ = repair_organ_edges()
    overload_enter, overload_exit = publish_overload()
    sword_enter, sword_hold = publish_swordplant()
    night_enter, night_loop, night_glance = publish_night()
    combat = publish_combat()

    review("portal-v3", effects["portal"])
    review("search-v3", effects["search"])
    review("streak-v3", effects["streak"])
    review("voidstitch-v3", load_frames(KAEL / "voidstitch_alarm") + load_frames(KAEL / "voidstitch_pull") + load_frames(KAEL / "voidstitch_seal"))
    review("organ-edge-v3", organ, 220)
    review("overload-v3", overload_enter + [overload_enter[-1]] * 5 + overload_exit, 180)
    review("swordplant-v3", sword_enter + sword_hold * 3 + list(reversed(sword_enter)), 170)
    review("night-v3", night_enter + night_loop * 2 + night_glance + list(reversed(night_enter)), 170)
    review("combat-v3", combat["combat_grip_v3"] + combat["combat_glance_v3"] + combat["combat_runes_v3"], 150)
    print("Kael runtime assets published with contact sheets and GIF previews")


if __name__ == "__main__":
    main()
