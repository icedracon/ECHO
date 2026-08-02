const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const failures = [];
const notes = [];
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const check = (ok, message) => {
  if (!ok) failures.push(message);
};
const slash = (value) => value.split(path.sep).join("/");

function loadTsModule(name) {
  const source = read(name);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  Function("require", "module", "exports", output)(require, mod, mod.exports);
  return mod.exports;
}

function frameFolders() {
  const base = path.join(root, "public", "pixel");
  const result = new Map();
  const visit = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const frames = entries
      .filter((entry) => entry.isFile() && /^frame_\d+\.png$/.test(entry.name))
      .map((entry) => Number(entry.name.match(/\d+/)[0]))
      .sort((a, b) => a - b);
    if (frames.length) {
      const rel = slash(path.relative(base, dir));
      result.set(rel, frames);
      frames.forEach((frame, index) => check(frame === index, `${rel}: missing frame_${index}.png`));
      for (const frame of frames) {
        const file = path.join(dir, `frame_${frame}.png`);
        const png = fs.readFileSync(file);
        check(
          png.length >= 24 && png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
          `${rel}/frame_${frame}.png: invalid PNG`,
        );
        if (png.length >= 24) {
          check(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0, `${rel}: invalid dimensions`);
        }
      }
    }
    for (const entry of entries) if (entry.isDirectory()) visit(path.join(dir, entry.name));
  };
  visit(base);
  return result;
}

const folders = frameFolders();
const { CORVIN, corvinClipTotal } = loadTsModule("src/corvin.ts");
const { KAEL, kaelClipTotal } = loadTsModule("src/kael.ts");

function validateClipCatalogue(label, clips, totalFn) {
  for (const [name, clip] of Object.entries(clips)) {
    check(Array.isArray(clip.frames) && clip.frames.length > 0, `${label} ${name}: empty clip`);
    check(clip.ms > 0, `${label} ${name}: invalid frame time`);
    check(clip.settle >= 0 && clip.settle < clip.frames.length, `${label} ${name}: invalid settle frame`);
    if (clip.msSeq) {
      check(clip.msSeq.length === clip.frames.length, `${label} ${name}: msSeq/frame count mismatch`);
      check(clip.msSeq.every((ms) => ms > 0), `${label} ${name}: non-positive msSeq value`);
    }
    check(totalFn(clip) > 0, `${label} ${name}: zero duration`);
    for (const url of clip.frames) {
      const match = url.match(/^\/pixel\/(.+?)\?v=/);
      check(Boolean(match), `${label} ${name}: malformed frame URL ${url}`);
      if (match) {
        const file = path.join(root, "public", "pixel", match[1]);
        check(fs.existsSync(file), `Missing ${match[1]}`);
        if (fs.existsSync(file)) {
          const png = fs.readFileSync(file);
          check(
            png.length >= 24 && png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
            `${label} ${name}: invalid PNG ${match[1]}`,
          );
          if (png.length >= 24) {
            const width = png.readUInt32BE(16);
            const height = png.readUInt32BE(20);
            check(width > 0 && height > 0, `${label} ${name}: invalid dimensions`);
            if (label === "Kael") {
              check(width === 128 && height === 128, `${label} ${name}: expected 128x128, found ${width}x${height}`);
              const colorType = png[25];
              const hasAlpha = colorType === 4 || colorType === 6 || png.includes(Buffer.from("tRNS"));
              check(hasAlpha, `${label} ${name}: PNG has no transparency channel`);
            }
          }
        }
      }
    }
  }
}
validateClipCatalogue("Corvin", CORVIN, corvinClipTotal);
validateClipCatalogue("Kael", KAEL, kaelClipTotal);

const clipFile = (clip, index) => {
  const match = clip.frames[index].match(/^\/pixel\/(.+?)\?v=/);
  return match ? path.join(root, "public", "pixel", match[1]) : "";
};
const sameClipFrame = (left, leftIndex, right, rightIndex) => {
  const a = clipFile(left, leftIndex);
  const b = clipFile(right, rightIndex);
  return Boolean(a && b && fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b)));
};
for (const name of [
  "idle_v2",
  "breathe",
  "work_loop_v2",
  "typing_runes",
  "rest_loop_v2",
  "combat_idle_v2",
  "watch_loop_v3",
  "night_loop_v2",
]) {
  const c = KAEL[name];
  check(sameClipFrame(c, 0, c, c.frames.length - 1), `Kael ${name}: loop endpoints are not pixel-identical`);
}
for (const [left, leftIndex, right, rightIndex, label] of [
  [KAEL.work_enter, 12, KAEL.typing_runes, 0, "work enter -> typing runes"],
  [KAEL.typing_runes, 0, KAEL.work_exit, 0, "typing runes -> work exit"],
  [KAEL.work_exit, 12, KAEL.breathe, 0, "work exit -> breathe"],
  [KAEL.watch_loop_v3, 0, KAEL.screen_glance, 0, "watch loop -> screen glance"],
  [KAEL.screen_glance, 12, KAEL.watch_loop_v3, 0, "screen glance -> watch loop"],
  [KAEL.rest_enter, 12, KAEL.rest_loop_v2, 0, "rest enter -> loop"],
  [KAEL.weapon_draw_sword, 16, KAEL.combat_idle_v2, 0, "draw -> combat idle"],
  [KAEL.watch_enter_v3, 12, KAEL.watch_loop_v3, 0, "watch enter -> loop"],
  [KAEL.night_enter_v2, 12, KAEL.night_loop_v2, 0, "night enter -> loop"],
  [KAEL.leave_v2, 16, KAEL.return_v2, 0, "leave -> return portal"],
  [KAEL.voidstitch_alarm, 12, KAEL.voidstitch_pull, 0, "void alarm -> pull"],
  [KAEL.voidstitch_pull, 16, KAEL.voidstitch_seal, 0, "void pull -> seal"],
]) {
  check(sameClipFrame(left, leftIndex, right, rightIndex), `Kael ${label}: disconnected contact frame`);
}
for (const [left, leftIndex, right, rightIndex, label] of [
  [CORVIN.sit, 8, CORVIN.watchturn, 0, "sit -> media turn"],
  [CORVIN.watchturn, 12, CORVIN.watchloop, 0, "media turn -> watch loop"],
  [CORVIN.bbqwalk, 0, CORVIN.bbqsit, 0, "barbecue walk -> sit"],
  [CORVIN.bbqsit, 12, CORVIN.barbecue, 0, "barbecue sit -> eat"],
  [CORVIN.barbecue, 0, CORVIN.bbqfinish, 0, "barbecue eat -> finish"],
  [CORVIN.bbqfinish, 8, CORVIN.watchloop, 0, "barbecue finish -> watch"],
  [CORVIN.watchloop, 0, CORVIN.mediarest, 0, "watch -> sword rest"],
  [CORVIN.mediarest, 12, CORVIN.mediarestloop, 0, "sword rest -> loop"],
]) {
  check(sameClipFrame(left, leftIndex, right, rightIndex), `Corvin ${label}: disconnected contact frame`);
}
const danteFrame = (folder, index) => path.join(root, "public", "pixel", folder, `frame_${index}.png`);
const sameDanteFrame = (leftFolder, leftIndex, rightFolder, rightIndex) =>
  fs.readFileSync(danteFrame(leftFolder, leftIndex)).equals(fs.readFileSync(danteFrame(rightFolder, rightIndex)));
check(
  sameDanteFrame("d_blanketloop", 0, "d_blanketloop", 8) &&
    sameDanteFrame("d_blanketdown", 16, "d_blanketloop", 0) &&
    sameDanteFrame("d_blanketcheck", 0, "d_blanketloop", 0) &&
    sameDanteFrame("d_blanketcheck", 8, "d_blanketloop", 0),
  "Dante blanket down/loop/check contact frames must be pixel-identical",
);

const main = read("src/main.ts");
const planner = read("src/planner.ts");
const directorSource = read("src/director.ts");
const kaelSource = read("src/kael.ts");
const storySource = read("src/story.ts");
const styles = read("src/styles.css");
const directClipSource = String.raw`\bclip\(\s*"([^"]+)"\s*,\s*[\d_]+\s*,\s*(?:true|false)(?:\s*,\s*[\d_]+)?(?:\s*,\s*([\d_]+))?\s*\)`;
const directClip = new RegExp(directClipSource, "g");
for (const match of main.matchAll(directClip)) {
  const expected = Number((match[2] || "9").replaceAll("_", ""));
  const actual = folders.get(match[1])?.length || 0;
  check(actual === expected, `Dante ${match[1]}: code needs exactly ${expected} frames, found ${actual}`);
}

const declaredClips = new Map();
for (const match of main.matchAll(/const\s+(\w+)\s*=\s*clip\(\s*"([^"]+)"[^;]*\);/g)) {
  const call = match[0].match(new RegExp(directClipSource));
  if (call) declaredClips.set(match[1], { dir: match[2], count: Number(call[2] || 9) });
}
for (const match of main.matchAll(/(\w+)\.msSeq\s*=\s*\[([^\]]+)\]/g)) {
  const clip = declaredClips.get(match[1]);
  if (!clip) continue;
  const values = match[2].replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const count = (values.match(/[\d_]+/g) || []).length;
  check(count === clip.count, `Dante ${match[1]} (${clip.dir}): msSeq has ${count}, clip has ${clip.count}`);
}
const catalogueFolders = (clips) => new Set(
  Object.values(clips).flatMap((clip) => clip.frames.map((url) => {
    const match = url.match(/^\/pixel\/(.+)\/frame_\d+\.png\?v=/);
    return match ? match[1] : "";
  })).filter(Boolean),
);
const catalogueFolderKeys = (clips) => {
  const result = new Map();
  for (const [key, clip] of Object.entries(clips)) {
    for (const url of clip.frames) {
      const match = url.match(/^\/pixel\/(.+)\/frame_\d+\.png\?v=/);
      if (!match) continue;
      if (!result.has(match[1])) result.set(match[1], new Set());
      result.get(match[1]).add(key);
    }
  }
  return result;
};
const corvinFolders = catalogueFolders(CORVIN);
const kaelFolders = catalogueFolders(KAEL);
const corvinFolderKeys = catalogueFolderKeys(CORVIN);
const kaelFolderKeys = catalogueFolderKeys(KAEL);
// Legacy is explicit, never inferred. A newly generated pack with no runtime
// route must fail the audit instead of silently becoming "legacy" and being
// forgotten. These folders are superseded visual generations kept for review.
const approvedLegacyFolders = new Set([
  "fx_portal",
  "corvin/c_demonout",
  "corvin/c_doorfight",
  "corvin/c_doorwin",
  "corvin/c_armtrigger",
  "corvin/c_armcalm",
  "corvin/c_guard",
  "corvin/c_armblast",
  "corvin/c_armoctopus",
  "corvin/c_armretract",
  "kael/watch_loop_v2",
  "kael/repair",
  "kael/game_ready",
  "kael/huntloop",
  "kael/watchturn",
  "kael/watchloop",
  "kael/night_exit",
  "kael/organ_intro",
  "kael/organ_finale",
  "kael/organ_fade_v2",
]);
const explicitFolderStatus = new Map(
  [...approvedLegacyFolders].map((name) => [name, "legacy"]),
);
const folderStatuses = new Map();
for (const name of folders.keys()) {
  let status = explicitFolderStatus.get(name) || "runtime";
  if (name.startsWith("d_")) {
    check(main.includes(`"${name}"`) || planner.includes(`"${name}"`), `Unused Dante clip folder: ${name}`);
  }
  if (name.startsWith("corvin/")) {
    check(corvinFolders.has(name), `Uncatalogued Corvin clip folder: ${name}`);
    const active = [...(corvinFolderKeys.get(name) || [])].some((key) => main.includes(`CORVIN.${key}`)) ||
      main.includes(`/pixel/${name}/`);
    check(active || approvedLegacyFolders.has(name), `Unrouted Corvin clip folder: ${name}`);
    if (!active && approvedLegacyFolders.has(name)) status = "legacy";
  }
  if (name.startsWith("kael/")) {
    check(kaelFolders.has(name), `Uncatalogued Kael clip folder: ${name}`);
    const active = [...(kaelFolderKeys.get(name) || [])].some((key) => main.includes(`KAEL.${key}`)) ||
      main.includes(`/pixel/${name}/`);
    check(active || approvedLegacyFolders.has(name), `Unrouted Kael clip folder: ${name}`);
    if (!active && approvedLegacyFolders.has(name)) status = "legacy";
  }
  if (!name.includes("/")) {
    if (directorSource.includes(`"${name}"`)) status = "director";
    check(
      main.includes(`"${name}"`) || planner.includes(`"${name}"`) ||
        main.includes(`/pixel/${name}/`) || kaelSource.includes(`/pixel/${name}/`) ||
        explicitFolderStatus.has(name),
      `Unclassified general/FX clip folder: ${name}`,
    );
  }
  folderStatuses.set(name, status);
}
for (const name of approvedLegacyFolders) {
  check(folders.has(name), `Approved legacy folder no longer exists: ${name}`);
}

function stringSet(source, name) {
  const body = source.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  return new Set(body ? [...body[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]) : []);
}

const context = read("src-tauri/src/context.rs");
check(
  context.includes("fullscreen_game && !had_fullscreen && !steam_game"),
  "Steam fullscreen focus must not emit a second game_start",
);
check(
  /#\[cfg\(target_os = "linux"\)\]\r?\nfn media_session_playing\(\)/.test(context) &&
    context.includes('command_stdout("playerctl"') &&
    context.includes('org.mpris.MediaPlayer2.') &&
    /#\[cfg\(target_os = "macos"\)\]\r?\nfn media_session_playing\(\)/.test(context) &&
    context.includes('command_stdout("osascript"'),
  "Linux and macOS must emit real media heartbeats for shared-screen watch mode",
);
check(
    context.includes("resolve_media_state(play_kind, media_hit.is_some(), music_hit.is_some())") &&
    context.includes("last_media_seen.elapsed() < Duration::from_secs(45)") &&
    context.includes("!media_now") &&
    context.includes("fire_media = false;") &&
    // Music must never reach the watch scene: it has its own edge and its own
    // scenes (guitar / плакат). Only video seats him facing the monitor.
    context.includes('resolve_media_state("", true, false)') &&
    context.includes('classify("music.yandex.ru")') &&
    context.includes('kind: "music"'),
  "Media watch must retain the title fallback and keep video/music routes separate",
);
check(
  context.includes("trim_start_matches('\\u{feff}')"),
  "QA demo commands must accept BOM-prefixed PowerShell files",
);
check(
  main.includes('{ name: "door", firstAt: 15') && main.includes("run: () => doorFightScene(true)"),
  "Steam Door must remain a forced 15-minute appointment",
);
check(
  main.includes("GAME_SESSION_START_KEY") &&
    main.includes("GAME_SESSION_RESUME_GAP") &&
    main.includes("GAME_SESSION_CLOCKS_KEY"),
  "Game-session clocks must persist across quick ECHO restarts",
);
check(
  main.includes("saved >= startedAt - every && saved <= now"),
  "Armed and overdue game appointments must survive an ECHO restart",
);
check(
  main.includes("if (gamingActive()) {") && main.includes("runCorvinClock(false)"),
  "Corvin's small/pose Director must stay active during gaming",
);
check(
  main.includes("gaming edge folded into active session"),
  "Repeated gaming edges must not consume fixed hunt timing",
);
check(
  main.includes("function requiemPendingNow(") &&
    main.includes("gamingActive() && beatReady() && !requiemPendingNow()"),
  "23:40 Requiem must outrank Steam and the Director",
);
check(
  main.includes("const HARD_BEAT_RESERVE_MS = 45_000") &&
    main.includes("!committed() && !huntBeatDueSoon()") &&
    main.includes("!huntBeatDueSoon(HARD_BEAT_RESERVE_MS, now)") &&
    main.includes("}, 5_000);"),
  "Corvin's fixed hunt beats must reserve the stage and poll on a hard clock",
);
check(
  /function beatReady\(\)[\s\S]*?!introActive[\s\S]*?\n}/.test(main),
  "Fixed beats must wait for the startup walk-in instead of being consumed",
);
check(
  main.includes("function setState(state: State, force = false)") &&
    main.includes('finishSceneIdle("corvin scene")') &&
    main.includes('finishSceneIdle("media watch")') &&
    main.includes('setState("idle", true)') &&
    main.includes("committedUntil = 0"),
  "Finished Corvin and media scenes must not freeze on a protected transition frame",
);
check(
  main.includes('dbg("queued context wakes companion from off-screen")') &&
    main.includes("void returnScene();") &&
    main.includes("const shouldWake = contextQueue.some"),
  "Manual and meaningful context must bring an away companion back before draining",
);
check(
  main.includes('if (isManualContext(kind) && kind !== "demo_watch" && mediaWatching)') &&
    main.includes("manualMediaPauseUntil = Date.now() + 25_000") &&
    main.includes("Date.now() >= manualMediaPauseUntil"),
  "Manual QA and hotkey scenes must be able to exit continuous media watch cleanly",
);
check(
  /#sprite\s*\{[\s\S]*?height:\s*190px;[\s\S]*?\}/.test(styles) &&
    /#bubble\s*\{[\s\S]*?bottom:\s*200px;[\s\S]*?max-width:\s*240px;[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?\}/.test(styles),
  "Speech bubbles must stay above the character and wrap long text without covering the sprite",
);
check(
  main.includes("const CORVIN_NIGHT_STONE_TOSSES = 3;") &&
    main.includes("toss <= CORVIN_NIGHT_STONE_TOSSES") &&
    main.includes("...CORVIN.stonetoss.frames.slice(0, 9).reverse()"),
  "Corvin night watch must catch the same pebble exactly three times",
);
check(
  main.includes("function nightWatchWindowNow(at = new Date())") &&
    main.includes("return (h === 0 && minute >= 40) || (h >= 1 && h < 5)") &&
    main.includes("const nightWatchWindow = nightWatchWindowNow(now)"),
  "00:40 night watch must catch up once after a late launch through 04:59",
);
check(
  main.includes("function paceMul(c?: Clip): number") &&
    // Authored scenes remain at 1.0 while the existing ambient energy response
    // stays intact. Visual QA must never rewrite either playback speed.
    main.includes("if (gagActive || introActive || showcasing || returning || wandering || away) return 1;") &&
    main.includes('if (isKael() && kaelMode !== "idle") return 1;') &&
    main.includes("if (isPhysicalClip(c)) return 1;") &&
    main.includes("return Math.min(1.12, Math.max(0.88, 1.14 - life.v.energy * 0.26));") &&
    !main.includes("GLOBAL_ANIMATION_PACE") &&
    !main.includes("DANTE_PACE") &&
    !main.includes("DANTE_MOTOR_PACE") &&
    main.includes("* paceMul(curClip)") &&
    main.includes("corvinClipTotal(c) * paceMul(c as Clip) * passes") &&
    main.includes("async function playKaelMode(") &&
    main.includes("const total = kaelClipTotal(c) * passes") &&
    !main.includes("async function playKael(") &&
    main.includes("* paceMul(c);") &&
    main.includes("const finishedClip = curClip;") &&
    main.includes("if (generation !== frameGeneration || curClip !== finishedClip) return;") &&
    main.includes("}, shownMs);"),
  "Authored scenes must stay at 1.0 pace and await every rendered frame",
);
check(
  main.includes('const KAEL_MODE_CANCELLED = Symbol("kael-mode-cancelled")') &&
    main.includes("function requireKaelMode(token: number)") &&
    main.includes("function startKaelModeClip(token: number") &&
    main.includes("async function playKaelMode(") &&
    main.includes("async function holdKaelModeLoop(") &&
    main.includes('isKael() && kaelMode !== "idle"') &&
    main.includes("await playKaelMode(kaelWatchToken, KAEL.watch_enter_v3)") &&
    main.includes("await holdKaelModeLoop(token, KAEL.night_loop_v2"),
  "Kael scenes must run through the cancellable mode controller and hold linked poses",
);
check(
  main.includes('original === "kael" && isKael() && gamingActive()') &&
    main.includes('ensureKaelCombatReady("video review restore")'),
  "Video-review restore must return Kael to sword-state during active games",
);
check(
  main.includes('stage.dataset.facing = isKael() ? "left" : "right"') &&
    main.includes("const gaitRate = 1.109375 - 0.4 * contact") &&
    main.includes("const fittedPace = distance / (cycles * cycleMs / 1000)") &&
    main.includes("slideKaelWalk(cornerX, 125)") &&
    KAEL.walkin.frames.length === 8 &&
    kaelClipTotal(KAEL.walkin) === 1260,
  "Kael entrance must face inward and foot contacts must slow without freezing the window",
);
const rawCorvinWaits = main
  .split("\n")
  .filter((line) => line.includes("await sleep(corvinClipTotal(") && !line.includes("paceMul("));
check(rawCorvinWaits.length === 0, "Direct Corvin clip waits must use the rendered pace");
check(
  main.includes('dbg("micro clip refused: looping clips require a mode owner")') &&
    /function playMicro\(c: CorvinClip\) \{\s*if \(c\.loop\)/.test(main),
  "Loop clips must not run as ownerless micro-scenes",
);
check(!/curClip\s*=\s*KAEL\./.test(main), "Kael clips must be switched through startClip/mode ownership");
check(
    main.includes('type KaelMode = "idle" | "work" | "watch" | "combat" | "night" | "away" | "scene"') &&
    main.includes('type KaelWeaponForm = "dormant" | "sword" | "scythe"') &&
    main.includes("async function kaelWorkSession()") &&
    main.includes("KAEL.work_enter") &&
    main.includes("KAEL.typing_runes") &&
    main.includes("KAEL.work_exit"),
  "Kael work must use the mode controller and the connected typing-runes shell loop",
);
check(
  main.includes('ensureKaelCombatReady(canResume ? "game resumed" : "game started")') &&
    main.includes('ensureKaelWeaponDormant("game ended")') &&
    main.includes("kaelPendingDraw") &&
    main.includes("kaelPendingStow"),
  "Kael weapon state must survive game resume and draw/stow exactly once",
);
check(
  kaelClipTotal(KAEL.organ_sense_v2) === 2500 &&
    kaelClipTotal(KAEL.organ_summon_v2) === 6000 &&
    kaelClipTotal(KAEL.organ_play_v2) === 2500 &&
    kaelClipTotal(KAEL.organ_memory_v3) === 8000 &&
    kaelClipTotal(KAEL.organ_platypus_v2) === 4000 &&
    kaelClipTotal(KAEL.organ_fade_v3) === 4000,
  "Kael organ clips must match the 47-second visual timeline without frozen tails",
);
const kaelOrganStart = main.indexOf("async function kaelVoidOrganScene(");
const kaelOrganEnd = main.indexOf("// Execution", kaelOrganStart);
const kaelOrganBody = kaelOrganStart >= 0 && kaelOrganEnd > kaelOrganStart
  ? main.slice(kaelOrganStart, kaelOrganEnd)
  : "";
check(
  main.includes('const KAEL_ORGAN_TRACK_URL = "/media/kael-passacaglia.mp3";') &&
    fs.existsSync(path.join(root, "public", "media", "kael-passacaglia.mp3")) &&
    kaelOrganBody.includes("KAEL.organ_sense_v2, 5_000") &&
    kaelOrganBody.includes("KAEL.organ_summon_v2, 6_000") &&
    kaelOrganBody.includes("startKaelModeClip(token, KAEL.organ_play_v2)") &&
    kaelOrganBody.includes("soundtrack started at seated first note") &&
    kaelOrganBody.includes("waitUntil(20)") &&
    kaelOrganBody.includes("KAEL.organ_memory_v3, 28") &&
    kaelOrganBody.includes("KAEL.organ_platypus_v2, 32") &&
    kaelOrganBody.includes("KAEL.organ_fade_v3, 36, true"),
  "Kael organ must keep an 11-second silent ritual and start music on the seated first note",
);
const hotkeySongStart = main.indexOf('if (kind === "hotkey_song")');
const hotkeySongEnd = main.indexOf('// ALT+B', hotkeySongStart);
const hotkeySongBody = hotkeySongStart >= 0 && hotkeySongEnd > hotkeySongStart
  ? main.slice(hotkeySongStart, hotkeySongEnd)
  : "";
check(
  hotkeySongBody.includes("if (isCorvin()) void nightSongScene();") &&
    hotkeySongBody.includes("else if (isKael()) void kaelVoidOrganScene(true);") &&
    hotkeySongBody.includes("else posterScene(30_000);"),
  "Alt+S must route to Corvin's song, Kael's organ, or Dante's poster by active character",
);
const riftSnackStart = main.indexOf("async function corvinVideoRiftSnackBeat(");
const riftSnackEnd = main.indexOf("async function holdWhileWatching(", riftSnackStart);
const riftSnackBody = riftSnackStart >= 0 && riftSnackEnd > riftSnackStart
  ? main.slice(riftSnackStart, riftSnackEnd)
  : "";
check(
  riftSnackBody.includes("CORVIN.bbqwalk") &&
    riftSnackBody.includes("CORVIN.bbqsit") &&
    riftSnackBody.includes("CORVIN.bbqfinish") &&
    !riftSnackBody.includes("CORVIN.turnback"),
  "Corvin must return from the media rift with visible food and never cross a front-facing turn",
);
const mediaRestStart = main.indexOf("async function corvinVideoSwordRestBeat(");
const mediaRestEnd = main.indexOf("async function mediaWatchScene()", mediaRestStart);
const mediaRestBody = mediaRestStart >= 0 && mediaRestEnd > mediaRestStart
  ? main.slice(mediaRestStart, mediaRestEnd)
  : "";
check(
  mediaRestBody.includes("CORVIN.mediarest") &&
    mediaRestBody.includes("CORVIN.mediarestloop") &&
    !mediaRestBody.includes("CORVIN.sitstone"),
  "Corvin film rest must remain in the rear-facing media pose",
);
const mediaWatchStart = main.indexOf("async function mediaWatchScene()");
const mediaWatchEnd = main.indexOf("// ---- Daily life", mediaWatchStart);
const mediaWatchBody = mediaWatchStart >= 0 && mediaWatchEnd > mediaWatchStart
  ? main.slice(mediaWatchStart, mediaWatchEnd)
  : "";
check(
  mediaWatchBody.includes('await ensureCorvinStanding("media watch entry");') &&
    mediaWatchBody.includes('await ensureCorvinSeated("media watch");') &&
    mediaWatchBody.includes("await playCorvin(CORVIN.watchturn);") &&
    mediaWatchBody.includes("await playCorvin(REV(CORVIN.watchturn));") &&
    mediaWatchBody.includes('await ensureCorvinStanding("media watch exit");'),
  "Corvin media watch must sit before turning and stand only after turning back",
);
const doorStart = main.indexOf("async function doorFightScene(");
const doorEnd = main.indexOf("// M1.5: breathing", doorStart);
const doorBody = doorStart >= 0 && doorEnd > doorStart ? main.slice(doorStart, doorEnd) : "";
check(
  doorBody.includes("startClip(CORVIN.walkin as Clip);") &&
    doorBody.includes("await slideFootstepWindow(homeX, CORVIN.walkin, 125);") &&
    !doorBody.includes("await slideWindow(homeX"),
  "Corvin must walk back from the Door on footfalls instead of gliding",
);
check(
  main.includes("const DANTE_LEGACY_MOTO_AFTER_MS = 12 * 60_000;") &&
    main.includes("async function danteLegacyMotoWatchBeat(") &&
    main.includes("async function danteLegacyMotoTourBody()") &&
    main.includes("await danteLegacyMotoTourBody();") &&
    main.includes('kind === "demo_moto_legacy"'),
  "The v0.2.4 full motorcycle tour must remain a separate long-film beat and QA scene",
);
check(
  main.includes("async function videoReviewScene()") &&
    main.includes('prepare("dante")') &&
    main.includes('prepare("corvin")') &&
    main.includes('prepare("kael")') &&
    main.includes('kind === "demo_video_review"'),
  "The shared video review must exercise Dante, Corvin, and Kael without real timers",
);
check(
  main.includes("async function danteReviewScene()") &&
    main.includes('kind === "demo_dante_review"') &&
    context.includes('"dantreview" | "dante_review" => "demo_dante_review"'),
  "Dante old/new review trigger must route to the real showcase",
);
const fullReviewStart = main.indexOf("async function fullReviewScene()");
const fullReviewEnd = main.indexOf("async function corvinVideoRiftSnackBeat", fullReviewStart);
const fullReviewBody = fullReviewStart >= 0 && fullReviewEnd > fullReviewStart
  ? main.slice(fullReviewStart, fullReviewEnd)
  : "";
check(
  fullReviewBody.includes("await videoReviewScene()") &&
    fullReviewBody.includes("await danteReviewScene()") &&
    fullReviewBody.includes("await demoCorvin()") &&
    fullReviewBody.includes("await doorFightScene(true)") &&
    fullReviewBody.includes("await nightWatchScene(true)") &&
    fullReviewBody.includes("await kaelReviewScene()") &&
    main.includes('kind === "demo_full_review"') &&
    context.includes('"fullreview" | "full_review"'),
  "Full polish review must cover shared video, Dante, Corvin, Door/night, and Kael",
);
const backendDemos = new Set([...context.matchAll(/=>\s*"(demo_[a-z_]+)"/g)].map((match) => match[1]));
const handledDemos = new Set([...main.matchAll(/kind\s*===\s*"(demo_[a-z_]+)"/g)].map((match) => match[1]));
const danteDemos = stringSet(main, "DANTE_DEMOS");
const corvinDemos = stringSet(main, "CORVIN_DEMOS");
const kaelDemos = stringSet(main, "KAEL_DEMOS");
const sharedDemos = new Set([
  "demo_watch", "demo_nightwatch", "demo_video_review", "demo_full_review",
]);
for (const demo of backendDemos) {
  check(handledDemos.has(demo), `Backend trigger ${demo} has no frontend handler`);
  if (demo === "demo_be_corvin" || demo === "demo_be_dante" || demo === "demo_be_kael") continue;
  const owners = Number(danteDemos.has(demo)) + Number(corvinDemos.has(demo)) + Number(kaelDemos.has(demo));
  if (sharedDemos.has(demo)) {
    check(owners === 0, `${demo}: shared trigger must preserve the active character`);
  } else {
    check(owners === 1, `${demo}: expected exactly one character owner, found ${owners}`);
  }
}
const automaticAndHotkeyKinds = [
  "typing", "cursor_left", "cursor_right", "cursor_far", "battery_low",
  "game_start", "gaming", "gaming_active", "gaming_fg",
  "media", "media_active", "music", "hotkey_song", "hotkey_story",
  "quiet_hour", "show_help",
];
for (const kind of automaticAndHotkeyKinds) {
  check(main.includes(`kind === "${kind}"`), `Runtime trigger ${kind} has no frontend route`);
}
check(
  context.includes('Some(("hotkey_song", "ALT+S -> song"))') &&
    context.includes('Some(("hotkey_story", "ALT+B -> story"))'),
  "ALT+S and ALT+B must both be emitted by the global hotkey watcher",
);
check(
  context.includes('"youtube" | "yt" | "youtube_poster" => "demo_youtube_poster"') &&
    main.includes('kind === "demo_youtube_poster"') &&
    main.includes("void posterScene(15_000)") &&
    fs.existsSync(path.join(root, "public", "media", "poster.gif")) &&
    fs.existsSync(path.join(root, "public", "media", "song.mp3")),
  "YouTube QA trigger must run Dante's GIF/MP3 scene and ship both media assets",
);
check(
  context.includes("if media_title_now && !had_media_title") &&
    context.includes("fire_media = true;") &&
    context.includes("let music_hit = titles") &&
    main.includes('if (kind === "music")') &&
    main.includes("else posterScene(15_000)"),
  "YouTube/Netflix titles must drive watch mode while music titles retain song scenes",
);
check(
  main.includes("function armQaReturn(target: CharacterName)") &&
    main.includes("QA test returned to") &&
    main.includes("armQaReturn(qaOriginalCharacter)") &&
    main.includes("qaRecoveryUntil = Date.now() + 6_000") &&
    main.includes("if (Date.now() < qaRecoveryUntil && !isManualContext(kind))") &&
    main.includes("if (!isManualContext(contextQueue[i])) contextQueue.splice(i, 1)"),
  "QA scenes must return to the originally selected companion and clean idle state",
);
check(
  main.includes("ownedMediaUntil = Date.now() + durationMs + 5_000") &&
    main.includes('if ((kind === "music" || kind === "music_active") && Date.now() < ownedMediaUntil)') &&
    main.includes("music ignored: owned by ECHO poster scene"),
  "Dante poster audio must not feed a second music trigger back into ECHO",
);
check(
  main.includes("const spriteLeft = h.lastX + h.winW - spriteW") &&
    main.includes("const spriteTop = h.lastY + h.winH - spriteW") &&
    main.includes("const py = Math.max(h.oy + 6, spriteTop + Math.round(handsOffsetPx * sf) - ph)") &&
    main.includes("const placePoster = async () =>") &&
    /await win\?\.show\(\)[\s\S]{0,220}await placePoster\(\)/.test(main),
  "Poster must stay near Dante on the active monitor and be repositioned after first show",
);
check(
  main.includes('consumeOverdueHuntClocks("character switch")') &&
    main.includes('consumeOverdueDanteClocks("character switch")') &&
    main.includes('consumeOverdueDanteClocks("session resume", now)') &&
    main.includes("function consumeOverdueDanteClocks(reason: string, now = Date.now())") &&
    main.includes("function consumeOverdueHuntClocks(reason: string, now = Date.now())") &&
    main.includes("for (const clock of due) clock.last = now") &&
    main.includes("hunt backlog folded (beat"),
  "Resume, character switches, and delayed hard beats must consume overdue choreography instead of bursting",
);
check(
  main.includes("cancelAnimationFrame(winTween)") &&
    main.includes("home.lastX = home.cornerX") &&
    main.includes("const CORVIN_DIRECTOR_GAP_MS = 60_000") &&
    main.includes("const CORVIN_GAMING_DIRECTOR_GAP_MS = 90_000") &&
    main.includes("lastCorvinDirectorAt = Date.now()") &&
    main.includes("if (!plannedId && now - lastCorvinDirectorAt < globalGap) return false"),
  "Character reset must cancel stale window physics and Corvin Director must keep a global action gap",
);

const tray = read("src-tauri/src/lib.rs");
const workflow = read(".github/workflows/build-unix.yml");
const readme = read("README.md");
const releaseTemplate = read(".github/RELEASE_TEMPLATE.md");
const trayEvents = new Set([...tray.matchAll(/item\("ev:([a-z_]+)"/g)].map((match) => match[1]));
check(
  tray.includes('item("ev:demo_be_kael"') &&
    tray.includes('"demo_be_kael" => Some("kael")') &&
    tray.includes("ECHO-Kael.exe"),
  "Tray and locked-exe character selection must include Kael",
);
check(
  workflow.includes("release-friendly/ECHO-Kael.exe") &&
    readme.includes("ECHO-Kael.exe") &&
    releaseTemplate.includes("ECHO-Kael.exe"),
  "Friendly Windows release assets must include ECHO-Kael.exe",
);
for (const event of trayEvents) {
  check(
    backendDemos.has(event) || event === "hotkey_song" || event === "quiet_hour",
    `Tray event ${event} is not routed by the backend`,
  );
}

const {
  ACTIONS,
  CORVIN_HARD_PLAN,
  CORVIN_HARD_PLAN_CYCLE_SEC,
  DANTE_ACTIONS,
  DANTE_HARD_PLAN,
  DANTE_HARD_PLAN_CYCLE_SEC,
  KAEL_ACTIONS,
  KAEL_HARD_PLAN,
  KAEL_HARD_PLAN_CYCLE_SEC,
  Director,
} = loadTsModule("src/director.ts");
const hardPlanClockIsStrict = (plan, cycleSec) =>
  plan.length > 0 && plan.every((beat, index) =>
    Number.isFinite(beat.atSec) &&
    beat.atSec > 0 &&
    beat.atSec < cycleSec &&
    (index === 0 || beat.atSec > plan[index - 1].atSec),
  );
const hardPlanSituation = {
  hour: 14,
  workMinutes: 45,
  typing: false,
  present: true,
  gaming: false,
  errStreak: 0,
  winStreak: 0,
  sinceSceneSec: 24 * 60 * 60,
};
for (const [label, actions, plan] of [
  ["Corvin", ACTIONS, CORVIN_HARD_PLAN],
  ["Dante", DANTE_ACTIONS, DANTE_HARD_PLAN],
  ["Kael", KAEL_ACTIONS, KAEL_HARD_PLAN],
]) {
  for (const beat of plan) {
    const action = actions.find((candidate) => candidate.id === beat.id);
    const brain = new Director(undefined, action ? [action] : []);
    check(brain.pick(hardPlanSituation, true) === null, `${label} hard action ${beat.id} leaked into random selection`);
    check(brain.takePlanned(beat.id, hardPlanSituation, true)?.id === beat.id, `${label} hard action ${beat.id} cannot be dispatched directly`);
  }
}
check(ACTIONS.every((action) => action.posture === "standing"), "Every Corvin Director action must require standing posture");
check(KAEL_ACTIONS.every((action) => action.posture === "standing"), "Every Kael Director action must require standing posture");
const directorStart = main.indexOf("function runCorvinClock(");
const directorEnd = main.indexOf("function runDanteClock(", directorStart);
const directorBody = directorStart >= 0 && directorEnd > directorStart
  ? main.slice(directorStart, directorEnd)
  : "";
const directorCases = new Set(
  [...directorBody.matchAll(/case\s+"([^"]+)"/g)].map((match) => match[1]),
);
for (const action of ACTIONS) check(directorCases.has(action.id), `Director action ${action.id} is not dispatched`);
check(
  directorBody.includes('if (a.kind === "big") markScene();'),
  "Corvin Director big actions must reserve the shared scene gap",
);
check(
  CORVIN_HARD_PLAN_CYCLE_SEC === 3 * 60 * 60 &&
    hardPlanClockIsStrict(CORVIN_HARD_PLAN, CORVIN_HARD_PLAN_CYCLE_SEC) &&
    CORVIN_HARD_PLAN.every((beat) => ACTIONS.some((action) => action.id === beat.id && action.planned)) &&
    new Set(CORVIN_HARD_PLAN.map((beat) => beat.id)).size === CORVIN_HARD_PLAN.length &&
    main.includes("const CORVIN_HARD_PLAN_TICK_MS = 1000;") &&
    main.includes("const CORVIN_HARD_PLAN_RECOVERY_GAP_MS = 120_000;") &&
    main.includes("runCorvinClock(true, due.id)") &&
    main.includes("scheduleCorvinHardPlan();"),
  "Every ordinary Corvin Director pack must have a unique slot in the three-hour hard reel",
);
const corvinHardRouted = new Set(CORVIN_HARD_PLAN.map((beat) => beat.id));
const corvinExplicitRoutes = new Set(["flask", "sleep", "scan", "artsiv", "bow", "door"]);
for (const action of ACTIONS) {
  check(
    corvinHardRouted.has(action.id) || corvinExplicitRoutes.has(action.id),
    `Corvin director action ${action.id} relies only on weighted Director selection`,
  );
}
check(
  main.includes('{ h: 2, name: "sleep", run: () => void sleepScene() }') &&
    main.includes('{ h: 12, name: "scan", run: () => void magicscanScene() }') &&
    main.includes('{ h: 23, name: "flask", run: () => void corvinScene(() => playCorvin(CORVIN.flask)) }') &&
    main.includes('await playCorvin(CORVIN.bow)') &&
    main.includes('run: () => doorFightScene(true)'),
  "Corvin special Director scenes must retain deterministic daily, intro, or game routes",
);
const danteDirectorStart = directorEnd;
const danteDirectorEnd = main.indexOf("function runKaelClock(", danteDirectorStart);
const danteDirectorBody = danteDirectorStart >= 0 && danteDirectorEnd > danteDirectorStart
  ? main.slice(danteDirectorStart, danteDirectorEnd)
  : "";
const danteDirectorCases = new Set(
  [...danteDirectorBody.matchAll(/case\s+"([^"]+)"/g)].map((match) => match[1]),
);
for (const action of DANTE_ACTIONS) {
  check(danteDirectorCases.has(action.id), `Dante director action ${action.id} is not dispatched`);
}
check(
  DANTE_HARD_PLAN_CYCLE_SEC === 4 * 60 * 60 &&
    hardPlanClockIsStrict(DANTE_HARD_PLAN, DANTE_HARD_PLAN_CYCLE_SEC) &&
    DANTE_HARD_PLAN.length === 42 &&
    DANTE_HARD_PLAN.every((beat) => DANTE_ACTIONS.some((action) => action.id === beat.id && action.planned)) &&
    DANTE_ACTIONS.every((action) => action.planned) &&
    new Set(DANTE_HARD_PLAN.map((beat) => beat.id)).size === DANTE_HARD_PLAN.length &&
    main.includes("const DANTE_DIRECTOR_TICK_MS = 1000;") &&
    main.includes("const DANTE_HARD_PLAN_RECOVERY_GAP_MS = 90_000;") &&
    main.includes("runDanteClock(true, due.id)") &&
    planner.includes('!u.clip.startsWith("d_")') &&
    planner.includes("export function dantePolishUrge("),
  "Every autonomous Dante move must be hard-routed and excluded from the weighted lottery",
);
const danteHardRouted = new Set(DANTE_HARD_PLAN.map((beat) => beat.id));
const danteExplicitRoutes = new Set(["d_coffee"]);
for (const action of DANTE_ACTIONS) {
  check(
    danteHardRouted.has(action.id) || danteExplicitRoutes.has(action.id),
    `Dante director action ${action.id} relies only on weighted Director selection`,
  );
}
const danteSeatedActions = new Set([
  "sitswing", "sitcross", "sitthink", "leanback", "laugh", "checkwatch", "yawn",
  "nap", "stretch", "shrug", "headtilt", "lookout", "cleansword", "d_glanceover",
  "d_bootswing", "d_neckroll", "d_jacketflick", "d_knuckles", "d_hairswipe",
  "d_sigh", "d_sitedge", "d_phone", "d_fingerguns", "d_coffee", "d_layback", "pizza",
]);
for (const action of DANTE_ACTIONS) {
  const expected = danteSeatedActions.has(action.id) ? "seated" : "standing";
  check(action.posture === expected, `Dante action ${action.id}: expected ${expected} posture, found ${action.posture}`);
}
check(
  main.includes('{ h: 10, name: "coffee", run: () => void demoSeated(idleClip("d_coffee")) }'),
  "Dante coffee must retain a deterministic waking-day route outside the hard reel",
);
const dantePackRoutes = new Map(Object.entries({
  checkwatch: "hard:checkwatch",
  cheer: "hard:cheer",
  cleansword: "hard:cleansword",
  climb: "hard:dive",
  coinflip: "hard:coin",
  d_blanketcheck: "context:night-watch",
  d_blanketdown: "context:night-watch",
  d_blanketloop: "context:night-watch",
  d_bootswing: "hard:d_bootswing",
  d_coffee: "daily:coffee",
  d_crouchpeer: "hard:d_crouchpeer",
  d_devilburn: "hard:devilform",
  d_devilcalm: "hard:devilform",
  d_devilrise: "hard:devilform",
  d_fingerguns: "hard:d_fingerguns",
  d_glanceover: "hard:d_glanceover",
  d_hairswipe: "hard:d_hairswipe",
  d_jacketflick: "hard:d_jacketflick",
  d_knuckles: "hard:d_knuckles",
  d_layback: "hard:d_layback",
  d_motooff: "hard:moto",
  d_motoride: "hard:moto",
  d_motowheelie: "hard:moto",
  d_neckroll: "hard:d_neckroll",
  d_phone: "hard:d_phone",
  d_sigh: "hard:d_sigh",
  d_sitedge: "hard:d_sitedge",
  d_standlean: "hard:d_standlean",
  d_watchloop: "context:media-watch",
  d_watchturn: "context:media-watch",
  dance: "hard:dance",
  demon_arm: "context:corvin-door",
  demon_arm_out: "context:corvin-door",
  devil: "hard:deviltrigger",
  falling: "hard:dive",
  fx_burst: "context:corvin-door",
  fx_portal: "legacy:superseded",
  fx_tendril: "context:corvin-door",
  gunspin: "hard:gunspin",
  headbang: "hard:headbang",
  headtilt: "hard:headtilt",
  laugh: "hard:laugh",
  leanback: "hard:leanback",
  lookout: "hard:lookout",
  nap: "hard:nap",
  pizza: "hard:pizza",
  shoot: "hard:shoot",
  shrug: "hard:shrug",
  sidewalk: "context:presence",
  sit: "hard:standcross",
  sitcross: "hard:sitcross",
  sitpanel: "context:posture-bridge",
  sitswing: "hard:sitswing",
  sitthink: "hard:sitthink",
  stagger: "hard:stagger",
  stretch: "hard:stretch",
  swordmove: "hard:swordmove",
  swordspin: "hard:swordspin",
  taunt: "hard:taunt",
  typetap: "context:typing",
  typing: "context:typing",
  wakeup: "hard:nap",
  yawn: "hard:yawn",
}));
const topLevelPackFolders = [...folders.keys()].filter((name) => !name.includes("/") && name !== "kael");
for (const folder of topLevelPackFolders) check(dantePackRoutes.has(folder), `Top-level animation pack ${folder} has no deterministic route`);
for (const [folder, route] of dantePackRoutes) {
  check(folders.has(folder), `Dante route manifest points to missing folder ${folder}`);
  if (route.startsWith("hard:")) {
    const actionId = route.slice(5);
    check(danteHardRouted.has(actionId), `Dante folder ${folder} points to missing hard action ${actionId}`);
  }
}
check(
  main.includes("await playDante(DANTE_BLANKET_DOWN)") &&
    main.includes("holdNightLoop(DANTE_BLANKET_LOOP") &&
    main.includes("startClip(DANTE_BLANKET_CHECK)") &&
    main.includes("await playDante(DANTE_WATCH_TURN)") &&
    main.includes("startClip(DANTE_WATCH_LOOP)") &&
    main.includes("startClip(TYPING, () => startClip(TYPETAP))") &&
    main.includes("slideFootstepWindow(h.cornerX, isCorvin() ? CORVIN.walkin : WALK") &&
    main.includes("const bridge = toSeated ? SITDOWN : reversedClip(SITDOWN)") &&
    main.includes('/pixel/demon_arm_out/frame_${fi}.png') &&
    main.includes('/pixel/demon_arm/frame_${(((t / 150) | 0) % 9)}.png') &&
    main.includes('/pixel/fx_burst/frame_${si++}.png') &&
    main.includes('/pixel/fx_tendril/frame_${((t / 110) | 0) % 9}.png'),
  "Every contextual Dante/FX pack must remain wired to its deterministic composite scene",
);
check(
  main.includes("function startDantePostureBridge(") &&
    main.includes("const bridge = toSeated ? SITDOWN : reversedClip(SITDOWN)") &&
    main.includes("dantePostureTransition !== null") &&
    main.includes("await ensureDantePosture(true)") &&
    main.includes('await ensureCorvinSeated("typing whetstone")') &&
    main.includes('await ensureCorvinStanding("typing finished")') &&
    main.includes("corvinPostureTransition !== null") &&
    main.includes('await ensureCorvinStanding("scene entry")') &&
    main.includes('await ensureCorvinStanding("scene exit")') &&
    main.includes('finishSceneIdle("corvin return")') &&
    !main.includes("curClip = CORVIN.whetstone as Clip") &&
    !danteDirectorBody.includes("playMicro(CORVIN.") &&
    !directorBody.includes("playMicro(CORVIN.") &&
    main.includes('if (kaelMode !== "idle" || kaelWeaponForm !== "dormant") return false;'),
  "Director dispatch must establish each character's required physical posture before frame zero",
);
const kaelDirectorStart = danteDirectorEnd;
const kaelDirectorEnd = main.indexOf("function scheduleDanteDirector()", kaelDirectorStart);
const kaelDirectorBody = kaelDirectorStart >= 0 && kaelDirectorEnd > kaelDirectorStart
  ? main.slice(kaelDirectorStart, kaelDirectorEnd)
  : "";
const kaelDirectorCases = new Set(
  [...kaelDirectorBody.matchAll(/case\s+"([^"]+)"/g)].map((match) => match[1]),
);
for (const action of KAEL_ACTIONS) {
  check(kaelDirectorCases.has(action.id), `Kael director action ${action.id} is not dispatched`);
}
check(
  KAEL_HARD_PLAN_CYCLE_SEC === 90 * 60 &&
    hardPlanClockIsStrict(KAEL_HARD_PLAN, KAEL_HARD_PLAN_CYCLE_SEC) &&
    JSON.stringify(KAEL_HARD_PLAN) === JSON.stringify([
      { id: "cloaksettle", atSec: 3 * 60 },
      { id: "razlomtap", atSec: 8 * 60 },
      { id: "platypus_sniff", atSec: 14 * 60 },
      { id: "armcheck", atSec: 21 * 60 },
      { id: "scarf", atSec: 29 * 60 },
      { id: "platypus", atSec: 38 * 60 },
      { id: "repair", atSec: 48 * 60 },
      { id: "cloaksettle", atSec: 58 * 60 },
      { id: "razlomtap", atSec: 65 * 60 },
      { id: "platypus_sniff", atSec: 72 * 60 },
      { id: "swordplant", atSec: 78 * 60 },
      { id: "rest", atSec: 86 * 60 },
    ]) &&
    KAEL_HARD_PLAN.every((beat) => KAEL_ACTIONS.some((action) => action.id === beat.id && action.planned)) &&
    directorSource.includes("if (a.planned) continue;") &&
    directorSource.includes("takePlanned(id: string") &&
    main.includes("const KAEL_DIRECTOR_TICK_MS = 1000;") &&
    main.includes("const KAEL_HARD_PLAN_GUARD_MS = 75_000;") &&
    main.includes("const KAEL_HARD_PLAN_RECOVERY_GAP_MS = 120_000;") &&
    main.includes("runKaelClock(true, due.id)") &&
    main.includes("async function kaelSwordPlantScene(holdMs = 3 * 60_000)"),
  "Every ordinary Kael pack must follow the exact 90-minute hard plan with a three-minute sword rest",
);
check(
  !main.includes("oldestUsefulCursor") &&
    !main.includes("due[due.length - 1]") &&
    main.includes("cursorAfter: corvinPlanCursor + 1") &&
    main.includes("cursorAfter: dantePlanCursor + 1") &&
    main.includes("cursorAfter: kaelPlanCursor + 1"),
  "Overdue hard-plan packs must remain queued in order instead of being silently folded away",
);
const kaelHardRouted = new Set(KAEL_HARD_PLAN.map((beat) => beat.id));
const kaelExplicitRoutes = new Set(["voidorgan", "voidstitch"]);
for (const action of KAEL_ACTIONS) {
  check(
    kaelHardRouted.has(action.id) || kaelExplicitRoutes.has(action.id),
    `Kael director action ${action.id} relies only on weighted Director selection`,
  );
}
check(
  main.includes('if (kind === "demo_voidorgan") return void kaelVoidOrganScene(true);') &&
    main.includes('if (kind === "demo_voidstitch") return void kaelVoidStitchScene();') &&
    main.includes('if (kind === "hotkey_song")') &&
    main.includes("void kaelVoidOrganScene();"),
  "Kael special Director scenes must retain deterministic hotkey, error, night, or demo routes",
);
check(
  main.includes("const kaelDirector = new Director(story.s.kaelDirector, KAEL_ACTIONS)") &&
    main.includes("function scheduleKaelDirector()") &&
    main.includes("scheduleKaelDirector();") &&
    main.includes("runKaelClock(false)"),
  "Kael Director must be stored, scheduled, and active during game sessions",
);
check(
  main.includes("const KAEL_MEDIA_GLANCE_AFTER_MS = 4 * 60_000;") &&
    main.includes("forcedDemo ? KAEL_MEDIA_GLANCE_DEMO_AFTER_MS : KAEL_MEDIA_GLANCE_AFTER_MS") &&
    main.includes("const CORVIN_MEDIA_RIFT_AFTER_MS = 4 * 60_000;") &&
    main.includes("const CORVIN_MEDIA_EAT_MS = 10_000;") &&
    main.includes("const CORVIN_MEDIA_SWORD_REST_MS = 3 * 60_000;") &&
    main.includes("const DANTE_BORED_RIDE_AFTER_MS = 75_000;") &&
    main.includes("const DANTE_LEGACY_MOTO_AFTER_MS = 12 * 60_000;"),
  "Media character beats must retain their authored hard timings",
);
check(
  storySource.includes("lastHourSlots?: Record<string, number>") &&
    main.includes("function hourSlotPlayed(key: string)") &&
    main.includes("function rememberHourSlot(key: string)") &&
    !main.includes("if (minute >= 10 && !requiemWindow && !nightWatchWindow) return;") &&
    main.includes("gagActive || showcasing || introActive || wandering || returning || committed() || quietNow()") &&
    main.includes("}, 15_000);") &&
    main.includes("Date.now() - last >= 12 * 3_600_000 && sceneAllowed()"),
  "Daily Dante/Corvin appointments must retry through their hour, persist per character, and wait for a safe stage",
);
check(
  context.includes('"organ" | "voidorgan" => "demo_voidorgan"') &&
    main.includes('if (kind === "demo_voidorgan") return void kaelVoidOrganScene(true);'),
  "Void organ demo trigger must route to Kael",
);

function decodeStrings(block) {
  return [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    JSON.parse(`"${match[1]}"`),
  );
}
function linesFrom(source) {
  const lines = [];
  for (const match of source.matchAll(/lines:\s*\[([\s\S]*?)\n\s*\],/g)) lines.push(...decodeStrings(match[1]));
  return lines;
}
const novel = read("src/novel.ts");
const tales = read("src/tales.ts");
const spoken = new Set([...linesFrom(novel), ...linesFrom(tales)]);
const titles = [...novel.matchAll(/title:\s*"((?:[^"\\]|\\.)*)"/g)].map((match) =>
  JSON.parse(`"${match[1]}"`),
);
titles.forEach((title, index) => spoken.add(`Глава ${index + 1}. ${title}.`));
for (const match of tales.matchAll(/opener:\s*"((?:[^"\\]|\\.)*)"/g)) {
  spoken.add(JSON.parse(`"${match[1]}"`));
}
const sadBlock = main.match(/const NIGHT_SAD_LINES = \[([\s\S]*?)\];/);
if (sadBlock) decodeStrings(sadBlock[1]).forEach((line) => spoken.add(line));
const voiceDir = path.join(root, "public", "voice", "corvin");
const voiceIndex = JSON.parse(fs.readFileSync(path.join(voiceDir, "index.json"), "utf8"));
for (const line of spoken) {
  const key = crypto.createHash("sha1").update(line).digest("hex").slice(0, 16);
  check(Boolean(voiceIndex[key]), `Missing Corvin voice: ${line.slice(0, 60)}`);
}
for (const entry of Object.values(voiceIndex)) {
  const file = path.join(voiceDir, entry.f);
  check(fs.existsSync(file), `Voice index points to missing ${entry.f}`);
  if (fs.existsSync(file)) check(fs.statSync(file).size > 512, `Voice file is empty or corrupt: ${entry.f}`);
}

notes.push(`${folders.size} animation folders, ${[...folders.values()].reduce((n, v) => n + v.length, 0)} PNG frames`);
notes.push(`folder status ${[...new Set(folderStatuses.values())].map((status) =>
  `${status}=${[...folderStatuses.values()].filter((value) => value === status).length}`
).join(", ")}`);
notes.push(`${Object.keys(CORVIN).length} Corvin clips, ${Object.keys(KAEL).length} Kael clips, ${declaredClips.size} named Dante clips`);
notes.push(`${backendDemos.size} demo triggers, ${ACTIONS.length + DANTE_ACTIONS.length + KAEL_ACTIONS.length} director actions`);
notes.push(`${automaticAndHotkeyKinds.length} automatic/hotkey trigger routes`);
notes.push(`${spoken.size} Corvin story lines, ${Object.keys(voiceIndex).length} voice files`);

if (failures.length) {
  console.error(`Runtime audit failed (${failures.length}):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`Runtime audit passed: ${notes.join("; ")}.`);
