# Release Checklist

Use this before publishing a GitHub release.

## Local verification

1. Confirm secrets are not in the diff:

   ```bash
   git diff -- . ':!.env'
   ```

2. Run the full local verification pass:

   ```bash
   npm run verify
   ```

3. Smoke-test the app:

   ```powershell
   .\Start ECHO.bat
   ```

4. Trigger the important demo scenes:

   ```powershell
   Set-Content "$env:USERPROFILE\.echo\demo" "corvin"
   Set-Content "$env:USERPROFILE\.echo\demo" "kael"
   Set-Content "$env:USERPROFILE\.echo\demo" "door"
   Set-Content "$env:USERPROFILE\.echo\demo" "dante"
   Set-Content "$env:USERPROFILE\.echo\demo" "devil"
   Set-Content "$env:USERPROFILE\.echo\demo" "watch"
   Set-Content "$env:USERPROFILE\.echo\demo" "videoreview"
   Set-Content "$env:USERPROFILE\.echo\demo" "youtube"
   Set-Content "$env:USERPROFILE\.echo\demo" "ride"
   Set-Content "$env:USERPROFILE\.echo\demo" "moto"
   Set-Content "$env:USERPROFILE\.echo\demo" "motolegacy"
   Set-Content "$env:USERPROFILE\.echo\demo" "nightwatch"
   Set-Content "$env:USERPROFILE\.echo\demo" "organ"
   Set-Content "$env:USERPROFILE\.echo\demo" "voidstitch"
   Set-Content "$env:USERPROFILE\.echo\demo" "fullweapon"
   Set-Content "$env:USERPROFILE\.echo\demo" "dantreview"
   Set-Content "$env:USERPROFILE\.echo\demo" "kaelreview"
   Set-Content "$env:USERPROFILE\.echo\demo" "fullreview"
   ```

   `fullreview` is the final connected pass. After it, test every individual
   trigger above once so a long sequence cannot hide a routing failure.
   Confirm every QA trigger returns the originally selected companion, home
   position, idle pose, and Kael weapon state when the scene finishes.

5. Visual checks:

   - speech bubble stays above the sprite and wraps inside the window;
   - character switch starts from a clean idle frame;
   - tray character menu contains Corvin, Dante and Kael;
   - Corvin's Door backstep reads as stepping, not sliding;
   - demon hand emerges slowly and never reaches Corvin;
   - Corvin becomes only partly demonic before the octopus attack;
   - corruption grows gradually until the tentacles physically contact the Door hand;
   - three octopus tentacles visibly grow from and retract into the screen-left demon arm beneath Artsiv;
   - no tentacle appears behind Corvin's back, around his legs or from the ground;
   - the lower demon claw never touches Corvin, including at maximum lunge;
   - return walk lands back on the taskbar corner.
   - the normal tray contains no manual scene buttons;
   - a QA demo trigger for the other character switches packs first and starts at frame 0;
   - Corvin's story text remains visible until the spoken line ends;
   - Corvin's chapter title and first line use the same voice at 1.5x speed without overlap.
   - opening YouTube/Netflix makes the active character sit and face the monitor centre without a menu command, including when Chrome reports SMTC `play=none` or labels the video `Music`;
   - Yandex Music/Spotify route to the selected character's music scene and never steal or fake a video-watch loop;
   - closing a video watched for over a minute is followed by the character's song (Dante `poster.gif` + `song.mp3`, Corvin guitar, Kael organ), and a game interrupting the watch suppresses it;
   - a music beat that lands within 3 minutes of another scene still plays instead of being dropped for twenty minutes;
   - an hour of music with no keystrokes does not make him wander off (`music_active` heartbeat);
   - idle/work clips visibly quicken at high energy; staged scenes stay locked to 1.0 and keep sound in sync;
   - the walk-in stride LANDS — feet plant where the window is, no mincing or sliding, at both high and low energy;
   - the arrival is walk → pause → full stand → sit, with NO mirror "glances" and no stagger: the sprite must never flip horizontally on arrival, and the stand-up motion must finish before the sit begins;
   - the sit finishes as the window reaches the seat, at both high and low energy;
   - opening a video plays the character's own answer FIRST (Dante плакат + gif + `song.mp3`, Corvin guitar, Kael organ), then he settles into the shared watch;
   - the gif window and `song.mp3` appear for Dante ONLY — never over Corvin or Kael;
   - Dante's watch turn keeps him seated and returns through the exact reverse frames;
   - Corvin keeps the sword across his knees and Artsiv visible throughout the watch loop;
   - closing media exits watch mode cleanly, while launching a game interrupts it with higher priority.
   - Alt+Tab away from and back into a Steam game does not restart the 3/7/10/15-minute session clocks;
   - restarting ECHO while a game is running starts a FRESH session at 0s — opening beat included, every clock armed from that moment (it no longer resumes the previous run's schedule);
   - restarting after a fight's due time queues that overdue fight instead of silently consuming it;
   - Corvin's Door fight starts at the 15-minute Steam appointment even if a daily/demo Door ran within four hours.
   - during Steam, Director logs and displays varied small/pose animations between fixed fights;
   - no Director pose or huntwatch starts in the 45 seconds before Corvin's 3/7/10/15-minute fights;
   - repeated `gaming` signals do not replay `magicscan` or postpone unchained/cleave/breach/Door;
   - `huntwatch` appears only occasionally and never becomes the sole gaming loop.
   - at 23:40, Requiem blocks new Director/Steam beats until the ritual starts, then plays once in full.
   - Corvin's video rest seats him against the cairn with the sword aside; Artsiv and the return-to-watch chain stay connected;
   - Dante mounts the motorcycle off-screen, keeps the same sportbike through ride/wheelie/return, then dismounts cleanly;
   - Dante's video ride says "Скучно.", leaves from the nearest edge, rides across the full display, falls from above, climbs, and returns to watch mode;
   - `motolegacy` remains a separate full motorcycle tour, not a replacement for the video ride;
   - Kael enters watch/work/night/combat through the mode controller, never walks in place, and never keeps an old loop after changing character;
   - Kael draws Rift once on game start or resume, keeps combat idle while gaming, and stows once after the game ends;
   - Kael's `Alt+S` organ scene keeps the 47-second visual timeline, starts music on the seated first note at 0:11, keeps Kael visible through `organ_fade_v3`, rises without a frozen frame, and restores sword-state if a game is active;
   - Kael's `voidstitch` runs as one connected alarm/pull/seal chain with the platypus warning first;
   - at 00:40, or once after a late launch through 04:59, the active character starts exactly one night-watch scene and does not collide with an already-running scene;
   - Corvin's night watch keeps the cairn, sword and Artsiv stable, then shows one pebble toss and a visible drop near his boot;
   - Dante's blanket comes from the desktop edge, covers his lying pose, then the wake/check/turn-back chain returns to sleep;
   - both night-watch variants restore the exact home position and a clean idle frame.
   - contact sheets cover Corvin, Dante/general, Kael and FX/other; no old clip
     folder is missing from the inventory or silently deleted;
   - layered-window captures use BitBlt with CAPTUREBLT at 100%, 125% and 150%
     DPI, showing the full display/taskbar relationship rather than a cropped app;
   - runtime evidence is checked in `~/.echo/echo.log` and
     `~/.echo/echo-fe.log`; YouTube detection uses the media watcher, not
     `tasklist /v` window titles;
   - Steam, daily appointments, media and Director do not overlap; hard clocks
     win and the lower-priority scene waits;
   - every asset change is followed by a fresh build; build status is read from
     the command exit code, not from piped display output.

6. Confirm `public/media/kael-passacaglia.mp3` may be redistributed. Replace or
   exclude it before a public release if distribution rights are unclear.

7. Search the staged diff for secrets. PixelLab, voice and authorization tokens
   must stay outside the repository and release artifacts.

## GitHub release

The workflow is `.github/workflows/build-unix.yml`.

Manual release:

1. Open GitHub Actions.
2. Run **Build Release**.
3. Use tag `v0.2.4`.
4. Confirm the release contains only the friendly downloads below, without duplicate technical filenames:

   - `ECHO-Windows-Setup.exe`;
   - `ECHO-Windows-x86_64.msi`;
   - `ECHO-Windows-Portable.exe`;
   - `ECHO-Corvin.exe`;
   - `ECHO-Dante.exe`;
   - `ECHO-Kael.exe`;
   - `ECHO-Linux-x86_64.AppImage`;
   - `ECHO-Debian-x86_64.deb`;
   - `ECHO-Fedora-x86_64.rpm`;
   - `ECHO-macOS-Apple-Silicon.dmg`;
   - `ECHO-macOS-Intel.dmg`.

5. Open the release page as a non-developer and confirm the first screen clearly says which single file to download for each operating system.

Tag release:

```bash
git tag v0.2.4
git push origin v0.2.4
```

## Notes

- macOS builds are not code-signed yet; Gatekeeper may warn.
- Windows builds are not code-signed yet; SmartScreen may warn.
- Runtime privacy claim: no telemetry and no network calls during normal app use.
- PixelLab/API tokens belong only in `.env`; rotate any token that was pasted into chat or logs.
