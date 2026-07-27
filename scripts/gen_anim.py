"""Generate a sprite animation via PixelLab animate-with-text-v3.

The endpoint that made all existing art (84x107 works; max 256x256, 4-16 even
frames, ~$0.02/gen). Reads PIXELLAB_API_KEY from .env in the repo root.

Usage:
  python scripts/gen_anim.py --base public/pixel/sit/frame_8.png \
      --action "swings a huge greatsword in a fierce combo" \
      --out public/pixel/sword --frames 8

  --base    reference frame (the character in the starting pose)
  --out     output dir; writes frame_0..N-1.png
  --frames  4-16, even (default 8)
  --last    optional last-frame image to guide the motion's end pose
  --seed    reproducibility (0 = random)
"""

import argparse
import base64
import json
import sys
import time
import urllib.request
from pathlib import Path

API = "https://api.pixellab.ai/v2"


def key() -> str:
    for line in (Path(__file__).parent.parent / ".env").read_text().splitlines():
        if line.startswith("PIXELLAB_API_KEY="):
            return line.split("=", 1)[1].strip()
    sys.exit("PIXELLAB_API_KEY not found in .env")


def call(path: str, payload: dict | None, api_key: str):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def b64(path: str) -> dict:
    return {"type": "base64", "base64": base64.b64encode(Path(path).read_bytes()).decode()}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--action", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--frames", type=int, default=8)
    ap.add_argument("--last")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    api_key = key()
    print("balance:", call("/balance", None, api_key))

    payload = {
        "first_frame": b64(args.base),
        "action": args.action,
        "frame_count": args.frames,
        "seed": args.seed,
        "no_background": True,
        "enhance_prompt": True,
    }
    if args.last:
        payload["last_frame"] = b64(args.last)

    r = call("/animate-with-text-v3", payload, api_key)
    job = r.get("background_job_id")
    print("job:", job, "status:", r.get("status"))
    if not job:
        sys.exit(f"no job id in response: {json.dumps(r)[:400]}")

    while True:
        time.sleep(4)
        jr = call(f"/background-jobs/{job}", None, api_key)
        status = jr.get("status")
        print("poll:", status)
        if status == "completed":
            break
        if status == "failed":
            sys.exit(f"generation failed: {json.dumps(jr)[:400]}")

    images = (
        jr.get("images")
        or (jr.get("result") or {}).get("images")
        or (jr.get("last_response") or {}).get("images")
        or []
    )
    if not images:
        sys.exit(f"no images in completed job; keys: {list(jr)}\n{json.dumps(jr)[:600]}")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for i, im in enumerate(images):
        data = im["base64"] if isinstance(im, dict) else im
        (out / f"frame_{i}.png").write_bytes(base64.b64decode(data))
    print(f"wrote {len(images)} frames -> {out}")
    print("usage:", jr.get("usage") or r.get("usage"))
    print("balance:", call("/balance", None, api_key))


if __name__ == "__main__":
    main()
