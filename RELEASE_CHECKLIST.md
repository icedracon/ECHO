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
   ```

5. Visual checks:

   - speech bubble stays above the sprite and wraps inside the window;
   - character switch starts from a clean idle frame;
   - Corvin's Door backstep reads as stepping, not sliding;
   - demon hand emerges slowly and never reaches Corvin;
   - octopus tendrils originate from Corvin's raised arm;
   - return walk lands back on the taskbar corner.
   - choosing a scene for the other character switches packs first and starts at frame 0;
   - Corvin's story text remains visible until the spoken line ends;
   - Corvin's chapter title and first line use the same voice at 1.5x speed without overlap.

## GitHub release

The workflow is `.github/workflows/build-unix.yml`.

Manual release:

1. Open GitHub Actions.
2. Run **Build Release**.
3. Use tag `v0.2.0`.
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
git tag v0.2.0
git push origin v0.2.0
```

## Notes

- macOS builds are not code-signed yet; Gatekeeper may warn.
- Windows builds are not code-signed yet; SmartScreen may warn.
- Runtime privacy claim: no telemetry and no network calls during normal app use.
- PixelLab/API tokens belong only in `.env`; rotate any token that was pasted into chat or logs.
