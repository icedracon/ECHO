"""Generate ECHO's voice lines with ElevenLabs into ~/.echo/voice/.

Run once: `python scripts/gen_voice.py` (needs ELEVENLABS_API_KEY in .env).
Files are named by a slug of the line text; the app slugifies each bubble the
same way and plays the matching clip, falling back to synthesized blips.

Uses an ORIGINAL stock voice — not a clone of any actor.
"""

import os
import re
import sys
from pathlib import Path

from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs

VOICE_ID = os.getenv("ECHO_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")  # deep male
MODEL_ID = "eleven_multilingual_v2"
OUT = Path.home() / ".echo" / "voice"

# Every line ECHO can say. Keep in sync with phrases/dante_lvl1.json + main.ts.
LINES = [
    # thinking / working
    "Let me think.", "Hold on.", "One second.", "Working it out.",
    "Writing code.", "Don't distract me.", "This will be clean.",
    "Digging around.", "It was here somewhere.", "Searching.",
    "Here you go.", "Done.", "Listen up.",
    # wins
    "Got it.", "As always.", "Easy.", "You doubted me?",
    "Next.", "Heh, too easy.", "Small stuff.", "Too easy.",
    "Jackpot!", "Come on!",
    # errors
    "Well, that broke.", "It happens.", "Not my fault.", "Blame the compiler.",
    "Pff, nothing.", "Sure, sure.", "Doesn't count.", "Come on, seriously?",
    "Whoa, falling!", "...climbing back up.", "...saw nothing.",
    # idle / presence
    "Quiet in here.", "Bored.", "Come on, give me something.", "Still waiting.",
    "Quiet. Taking a break.", "Call me if you need me.", "Bored. Going for a walk.",
    "Alright, let's go.", "I'm back.", "Let's get to work.",
    "Devil Trigger!",
]
EXTRA = {"hmm": "Hmm."}  # fixed-name clips the app asks for directly


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return s or "line"


def main() -> int:
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    key = os.getenv("ELEVENLABS_API_KEY")
    if not key:
        print("ELEVENLABS_API_KEY missing (.env)")
        return 1
    el = ElevenLabs(api_key=key)
    OUT.mkdir(parents=True, exist_ok=True)

    jobs = [(slug(t), t) for t in LINES] + list(EXTRA.items())
    made = skipped = failed = 0
    for name, text in jobs:
        dest = OUT / f"{name}.mp3"
        if dest.exists() and dest.stat().st_size > 512:
            skipped += 1
            continue
        try:
            audio = el.text_to_speech.convert(
                text=text,
                voice_id=VOICE_ID,
                model_id=MODEL_ID,
                output_format="mp3_44100_128",
                voice_settings={"stability": 0.45, "similarity_boost": 0.75, "style": 0.55},
            )
            data = b"".join(audio)
            if len(data) < 512:
                raise RuntimeError(f"tiny response ({len(data)}b)")
            dest.write_bytes(data)
            made += 1
            print(f"OK   {name:<28} {len(data):>7}b  {text}", flush=True)
        except Exception as e:  # keep going; report at the end
            failed += 1
            print(f"FAIL {name:<28} {type(e).__name__}: {str(e)[:160]}", flush=True)

    print(f"\ndone: {made} generated, {skipped} already present, {failed} failed -> {OUT}")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
