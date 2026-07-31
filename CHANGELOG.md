# Changelog

## 0.2.4 - 2026-08-01

### Added

- Automatic 00:40 night-watch scenes for both companions, with a once-per-night persisted trigger.
- Corvin cairn rest, Artsiv doze, pebble toss and pebble drop animation chains.
- Dante blanket pull, sleeping loop and wake/check/turn-back animation chains.
- Corvin's media-watch portal snack and seated barbecue sequence.
- Dante's full-width motorcycle ride, wheelie, return and off-screen dismount sequence.
- Character switch between Dante and Corvin from the tray menu.
- Windows portable aliases for release downloads:
  - `ECHO-Windows-Portable.exe`
  - `ECHO-Corvin.exe`
  - `ECHO-Dante.exe`
- Cross-platform release workflow for Windows, Linux and macOS.
- Linux release bundles: AppImage, deb and rpm.
- macOS release bundles for Apple Silicon and Intel.
- Friendly release aliases that say the operating system and package type in the filename.
- One-time first-run hint and a permanent **Как управлять ECHO** tray item.
- Corvin Door scene chain: sense, backstep, parry, sword plant, arm raise, octopus grip, calm and sword return.
- New Door assets: demon hand, hand emergence, burst FX and tendril FX.
- Dante has a separate learned director for his own ambient repertoire.
- Automatic shared-screen watch mode for Dante and Corvin when video or music is open.
- New seated turn and quiet watch-loop animations for both characters.

### Changed

- Corvin now rests seated against a cairn during long videos, with his sword laid aside instead of standing and leaning on it.
- Dante mounts the motorcycle off-screen and uses one continuous sportbike design through the ride, wheelie and dismount.
- Corvin's story, tale and grief voice now plays 1.5x faster.
- Scene triggers switch to the correct character before starting at frame 0.
- Dante scene waits now use the real per-frame timing sequence instead of average frame time.
- Dante clip changes repaint frame 0 immediately, preventing gliding starts and clipped endings.
- Busy scene triggers now wait in an ordered queue instead of expiring after 25 seconds.
- The tray is intentionally limited to character and comfort controls; scenes are autonomous.
- Main window size is now `260x420`, with a dedicated speech area above the character.
- Character switching resets scene state cleanly, so Dante scenes do not leak into Corvin and Corvin starts from the beginning.
- Door backstep now uses footfall-based window movement instead of a continuous glide.
- Demon hand emergence is slower and synced across Corvin's sense/backstep sequence.
- Demon hand lunge distance is capped so it does not enter Corvin's interaction zone.
- Three octopus tentacles now share one wrist-sized root on Corvin's screen-left demon arm and stay attached to the Door hand.
- Corvin now becomes only partially demonic before using the Door tentacles: his screen-left arm beneath Artsiv transforms while the sword stays planted at screen-right.
- Partial corruption now grows slowly with the tentacles and reaches its strongest frame only when they contact the Door hand.
- The Door claw is lower and has a shorter reach/lunge, leaving visible space between it and Corvin.
- The Door's demon arm stays rooted behind the screen edge during emergence, lunge and pushback.
- Release versions are aligned across `package.json`, `Cargo.toml`, `Cargo.lock` and `tauri.conf.json`.
- Package lock was cleaned of unused Three.js/Rapier-era dependencies.
- Media detection now keeps one serialized watch session alive with heartbeats instead of repeating poster or guitar scenes.
- Linux media playback is detected through MPRIS/D-Bus with X11 title fallbacks; macOS uses local window/player state.
- Games outrank media mode and make the companion leave the watch pose through its proper reverse animation.

### Fixed

- Night scenes now restore the exact taskbar home position and a clean idle frame after every exit.
- Dante's motorcycle no longer switches bike designs or snaps between incompatible arrival and ride clips.
- Corvin's media rest no longer freezes on a transition frame after returning from the cairn.
- Corvin scene and media-watch cleanup now forcibly releases the final protected frame instead of freezing side-on after the animation ends.
- A fixed game beat due during the startup walk-in now waits instead of being marked as played and refused.
- Steam's 15-minute Door fight no longer resets when returning to a fullscreen game after Alt+Tab.
- Active game-session clocks survive quick ECHO restarts and resume from their original minute.
- Individual hunt appointments persist too, preventing old 3/7/10-minute fights from replaying as a burst after restart.
- An overdue persisted fight now waits for the first free scene after restart instead of being marked as consumed.
- The fixed Steam Door appointment now bypasses the four-hour daily-scene cooldown and generic scene gap.
- Corvin's learned Director now continues choosing small and pose animations between fixed Steam fights.
- Repeated Steam/DNS gaming signals no longer replay the opening scan or consume the hunt scene gap.
- Huntwatch is now a rare gaming ambience instead of Corvin's dominant repeated animation.
- The 3/7/10/15-minute Corvin hunt beats are mandatory once their appointment is due.
- The 23:40 Requiem now explicitly outranks both Steam appointments and Director choices.
- Corvin now reserves the stage for 45 seconds before fixed Steam fights and checks their clocks every 5 seconds.
- Corvin's chapter titles now ship in the same local neural voice as every story line.
- Story bubbles remain visible until Corvin finishes speaking and no longer add a generic voice blip over his real voice.
- Voice timeout cleanup now stops the active source, preventing a late line from overlapping the next one.
- Dante's multi-spin gaming beat now restarts the clip for each spin instead of freezing on its settle frame.
- Long Russian speech bubbles no longer cover the character's head.
- Speech bubbles use the full safe width instead of collapsing into a tall narrow column.
- Corvin no longer receives Dante-only Devil Trigger/demo events.
- Windows launcher media copy path for `nightsong.mp3`.
- Windows launcher completion text now says ECHO instead of Dante.
- Windows source launcher now downloads the actual portable release filename.
- **Мои песни и постеры** now opens the media folder on Linux and macOS as well as Windows.
- Rust context watcher warning around overwritten state.

### Verified

- Live visual capture of Corvin's complete media sequence, Dante's motorcycle sequence and both 00:40 night-watch variants.
- `npm run audit:runtime` checks animation frames/timings, demo routing, director dispatch and Corvin voice coverage.
- `npm run build`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `npm run build:desktop:no-bundle`
