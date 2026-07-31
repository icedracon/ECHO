"""Pre-render Corvin's entire Russian voice with Microsoft's neural TTS.

Everything he says is fixed text — the novel, the tales, the sad lines — so it
gets rendered ONCE into mp3 and shipped with the build: no runtime API call, no
network dependency, no latency, and none of the 2011 robot Windows ships with.

Delivery profiles (user-approved):
  story  — measured, for the novel and the tales
  battle — faster and harder, for fight lines
  grief  — slow and low, for the sad lines
  break  — at the edge, for the breakdown

Output: public/voice/corvin/<hash>.mp3 plus index.json (line hash -> file), so
the engine looks a line up by its own text and can never drift out of sync.

    python scripts/gen_voice_corvin.py           # only what's missing
    python scripts/gen_voice_corvin.py --force   # re-render everything
"""

import asyncio
import hashlib
import json
import re
import sys
from pathlib import Path

import edge_tts

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "voice" / "corvin"
VOICE = "ru-RU-DmitryNeural"

PROFILES = {
    "story": {"rate": "-12%", "pitch": "-8Hz"},
    "battle": {"rate": "+6%", "pitch": "-4Hz"},
    "grief": {"rate": "-24%", "pitch": "-14Hz"},
    "break": {"rate": "-30%", "pitch": "-16Hz"},
}


def key(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def quoted_lines(block: str) -> list[str]:
    return [m.group(1).replace('\\"', '"') for m in re.finditer(r'"((?:[^"\\]|\\.)*)"', block)]


def lines_from(ts_path: Path) -> list[str]:
    """Every quoted string inside a `lines: [ ... ]` block."""
    src = ts_path.read_text(encoding="utf-8")
    out: list[str] = []
    for block in re.findall(r"lines: \[(.*?)\n\s*\],", src, re.S):
        out += quoted_lines(block)
    return out


def collect() -> dict[str, str]:
    """text -> delivery profile, for the whole corpus."""
    jobs: dict[str, str] = {}
    novel_path = ROOT / "src" / "novel.ts"
    for line in lines_from(novel_path):
        jobs[line] = "story"
    # Chapter headings are assembled at runtime, but they are spoken too. Keep
    # them in the same neural voice instead of falling back to the OS voice.
    novel_src = novel_path.read_text(encoding="utf-8")
    titles = [
        m.group(1).replace('\\"', '"')
        for m in re.finditer(r'title:\s*"((?:[^"\\]|\\.)*)"', novel_src)
    ]
    for idx, title in enumerate(titles, 1):
        jobs[f"Глава {idx}. {title}."] = "story"
    for line in lines_from(ROOT / "src" / "tales.ts"):
        jobs[line] = "story"
    # Arc openers ("Про птицу. Там есть ещё.") live outside the lines blocks.
    tales_src = (ROOT / "src" / "tales.ts").read_text(encoding="utf-8")
    for m in re.finditer(r'opener: "((?:[^"\\]|\\.)*)"', tales_src):
        jobs[m.group(1).replace('\\"', '"')] = "story"
    # Short authored lines in main.ts live outside the story/tale blocks.
    main_src = (ROOT / "src" / "main.ts").read_text(encoding="utf-8")
    for const_name, profile in [
        ("NIGHT_SAD_LINES", "grief"),
        ("CORVIN_NIGHT_GUARD_LINES", "story"),
        ("CORVIN_RARE_LINES", "story"),
    ]:
        m = re.search(rf"const {const_name} = \[(.*?)\];", main_src, re.S)
        if m:
            for line in quoted_lines(m.group(1)):
                jobs[line] = profile
    return jobs


async def render(jobs: dict[str, str], force: bool) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    index_path = OUT / "index.json"
    index: dict[str, dict] = (
        json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}
    )
    # Recover a clip written just before an interrupted run. The old loop only
    # checkpointed every 25 files, so a timeout could leave valid MP3s orphaned
    # and needlessly regenerate them on the next pass.
    if not force:
        for text, prof in jobs.items():
            k = key(text)
            existing = OUT / f"{k}.mp3"
            if k not in index and existing.exists() and existing.stat().st_size > 0:
                index[k] = {"f": existing.name, "p": prof}
        index_path.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
    todo = [(t, p) for t, p in jobs.items() if force or key(t) not in index]
    print(f"corpus: {len(jobs)} lines | rendering: {len(todo)}", flush=True)
    for i, (text, prof) in enumerate(todo, 1):
        k = key(text)
        o = PROFILES[prof]
        for attempt in range(3):
            try:
                target = OUT / f"{k}.mp3"
                if target.exists() and target.stat().st_size == 0:
                    target.unlink()
                c = edge_tts.Communicate(text, VOICE, rate=o["rate"], pitch=o["pitch"])
                async with asyncio.timeout(30):
                    await c.save(str(target))
                index[k] = {"f": f"{k}.mp3", "p": prof}
                break
            except Exception as e:  # network flakiness only — retry, then skip
                if attempt == 2:
                    print(f"  FAILED {text[:44]!r}: {e}", flush=True)
                else:
                    await asyncio.sleep(2 * (attempt + 1))
        if i % 25 == 0:
            index_path.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
            print(f"  {i}/{len(todo)}", flush=True)
    index_path.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
    mb = sum(f.stat().st_size for f in OUT.glob("*.mp3")) / 1048576
    print(f"done: {len(index)} clips, {mb:.1f} MB -> {OUT}", flush=True)


if __name__ == "__main__":
    asyncio.run(render(collect(), "--force" in sys.argv))
