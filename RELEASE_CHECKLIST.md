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
   Set-Content "$env:USERPROFILE\.echo\demo" "door"
   Set-Content "$env:USERPROFILE\.echo\demo" "dante"
   Set-Content "$env:USERPROFILE\.echo\demo" "devil"
   Set-Content "$env:USERPROFILE\.echo\demo" "watch"
   ```

5. Visual checks:

   - speech bubble stays above the sprite and wraps inside the window;
   - character switch starts from a clean idle frame;
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
   - opening supported video/music makes the active character sit and face the monitor centre without a menu command;
   - Dante's watch turn keeps him seated and returns through the exact reverse frames;
   - Corvin keeps the sword across his knees and Artsiv visible throughout the watch loop;
   - closing media exits watch mode cleanly, while launching a game interrupts it with higher priority.
   - Alt+Tab away from and back into a Steam game does not restart the 3/7/10/15-minute session clocks;
   - restarting ECHO while the same game remains active resumes the session clock;
   - restarting after a fight's due time queues that overdue fight instead of silently consuming it;
   - Corvin's Door fight starts at the 15-minute Steam appointment even if a daily/demo Door ran within four hours.
   - during Steam, Director logs and displays varied small/pose animations between fixed fights;
   - no Director pose or huntwatch starts in the 45 seconds before Corvin's 3/7/10/15-minute fights;
   - repeated `gaming` signals do not replay `magicscan` or postpone unchained/cleave/breach/Door;
   - `huntwatch` appears only occasionally and never becomes the sole gaming loop.
   - at 23:40, Requiem blocks new Director/Steam beats until the ritual starts, then plays once in full.

## GitHub release

The workflow is `.github/workflows/build-unix.yml`.

Manual release:

1. Open GitHub Actions.
2. Run **Build Release**.
3. Use tag `v0.2.3`.
4. Confirm the release contains only the friendly downloads below, without duplicate technical filenames:

   - `ECHO-Windows-Setup.exe`;
   - `ECHO-Windows-x86_64.msi`;
   - `ECHO-Windows-Portable.exe`;
   - `ECHO-Corvin.exe`;
   - `ECHO-Dante.exe`;
   - `ECHO-Linux-x86_64.AppImage`;
   - `ECHO-Debian-x86_64.deb`;
   - `ECHO-Fedora-x86_64.rpm`;
   - `ECHO-macOS-Apple-Silicon.dmg`;
   - `ECHO-macOS-Intel.dmg`.

5. Open the release page as a non-developer and confirm the first screen clearly says which single file to download for each operating system.

Tag release:

```bash
git tag v0.2.3
git push origin v0.2.3
```

## Notes

- macOS builds are not code-signed yet; Gatekeeper may warn.
- Windows builds are not code-signed yet; SmartScreen may warn.
- Runtime privacy claim: no telemetry and no network calls during normal app use.
- PixelLab/API tokens belong only in `.env`; rotate any token that was pasted into chat or logs.
