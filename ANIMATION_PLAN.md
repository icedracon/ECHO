# Pixel Dante — Animation Action Plan

## Current release note (v0.2.0)

This file began as the Dante animation plan. The current build is now ECHO with
both Dante and Corvin. Corvin's Door chain is live in `public/pixel/corvin/`:
`c_doorsense`, `c_backstep`, `parry`, `c_swordplant2`, `c_armup`,
`c_armoctopus`, `c_armretract`, `c_armcalm`, `c_swordtake`, plus the overlay FX under
`public/pixel/demon_*` and `public/pixel/fx_*`.

`c_armoctopus` and `c_armretract` contain only Corvin's clean partial-demon strain.
The nine-frame `fx_tendril` bundle owns all three tentacles, keeps one wrist-sized
root pinned to the screen-left arm beneath Artsiv, and never draws behind his back
or around his legs.

The Door backstep was regenerated for stronger leg motion. Its last frame is
pinned to `c_swordplant2/frame_0.png` so the scene remains one continuous chain.

## Done
- Base sprite (idle) — PixelLab `create-image-pixflux`, transparent.
- Living loop (9 frames) — `animate-with-text-v3`, bg color-keyed to transparent.
- Wired: frame player, per-state speed, CSS jump/shake, taskbar perch, walk-in intro, click-through, session sync, stars, bubbles. ~40MB RAM.
- Gens used: ~4 / 40.

## Animations to generate (PixelLab `animate-with-text-v3`, first_frame = idle sprite)

| # | Action prompt | State it drives | Loop? | ~Gens |
|---|---|---|---|---|
| 1 | `sit` | idle / waiting (real taskbar perch) | hold last frame | ~2 |
| 2 | `cheer` / `celebrate jump` | success | play once → idle | ~2 |
| 3 | `stagger back, hit` | error | play once → idle | ~2 |
| 4 | `typing / arms crossed thinking` (optional) | coding / thinking distinct | loop | ~2 |

Budget: ~8 gens for the full set → ~28 left after. Safe.

## Per-animation pipeline (repeat for each)
1. POST `animate-with-text-v3` `{action, first_frame}` → `background_job_id`.
2. Poll `GET /v2/background-jobs/{id}` until `completed` → save frames.
3. Color-key the solid bg → transparent (local, free).
4. Verify on magenta montage (no holes), copy to `public/pixel/<name>/`.

## Frontend changes (one pass, after frames exist)
- Turn the single FRAMES array into a **map**: `state -> {frames[], ms, loop}`.
- Frame player reads the active set; one-shots play once then fall back to the idle loop.
- **Sit** = swap to sit frames **and** drop the window to the taskbar-perch Y (reuse the earlier perch math); stand back up (walk/idle Y) for standing states.
- Keep CSS jump/shake as fallback only if a state has no generated frames.

## Order
1. **Sit** — highest value (the real perch you asked for).
2. **Cheer** — success payoff.
3. **Stagger** — error reaction.
4. Distinct coding/thinking — polish, optional.

## Notes
- Rotate the PixelLab API key when done (it's in chat history).
- All frames must be bg-keyed before use (animate endpoint returns solid bg, not transparent).
