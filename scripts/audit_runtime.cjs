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
for (const [name, clip] of Object.entries(CORVIN)) {
  check(Array.isArray(clip.frames) && clip.frames.length > 0, `Corvin ${name}: empty clip`);
  check(clip.ms > 0, `Corvin ${name}: invalid frame time`);
  check(clip.settle >= 0 && clip.settle < clip.frames.length, `Corvin ${name}: invalid settle frame`);
  if (clip.msSeq) {
    check(clip.msSeq.length === clip.frames.length, `Corvin ${name}: msSeq/frame count mismatch`);
    check(clip.msSeq.every((ms) => ms > 0), `Corvin ${name}: non-positive msSeq value`);
  }
  check(corvinClipTotal(clip) > 0, `Corvin ${name}: zero duration`);
  for (const url of clip.frames) {
    const match = url.match(/^\/pixel\/(.+?)\?v=/);
    check(Boolean(match), `Corvin ${name}: malformed frame URL ${url}`);
    if (match) check(fs.existsSync(path.join(root, "public", "pixel", match[1])), `Missing ${match[1]}`);
  }
}

const main = read("src/main.ts");
const directClipSource = String.raw`\bclip\(\s*"([^"]+)"\s*,\s*[\d_]+\s*,\s*(?:true|false)(?:\s*,\s*[\d_]+)?(?:\s*,\s*([\d_]+))?\s*\)`;
const directClip = new RegExp(directClipSource, "g");
for (const match of main.matchAll(directClip)) {
  const expected = Number((match[2] || "9").replaceAll("_", ""));
  const actual = folders.get(match[1])?.length || 0;
  check(actual >= expected, `Dante ${match[1]}: code needs ${expected} frames, found ${actual}`);
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
for (const name of folders.keys()) {
  if (name.startsWith("d_")) {
    check(main.includes(`"${name}"`) || read("src/planner.ts").includes(`"${name}"`), `Unused Dante clip folder: ${name}`);
  }
}

function stringSet(source, name) {
  const body = source.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  return new Set(body ? [...body[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]) : []);
}

const context = read("src-tauri/src/context.rs");
const backendDemos = new Set([...context.matchAll(/=>\s*"(demo_[a-z_]+)"/g)].map((match) => match[1]));
const handledDemos = new Set([...main.matchAll(/kind\s*===\s*"(demo_[a-z_]+)"/g)].map((match) => match[1]));
const danteDemos = stringSet(main, "DANTE_DEMOS");
const corvinDemos = stringSet(main, "CORVIN_DEMOS");
for (const demo of backendDemos) {
  check(handledDemos.has(demo), `Backend trigger ${demo} has no frontend handler`);
  if (demo === "demo_be_corvin" || demo === "demo_be_dante") continue;
  const owners = Number(danteDemos.has(demo)) + Number(corvinDemos.has(demo));
  check(owners === 1, `${demo}: expected exactly one character owner, found ${owners}`);
}

const tray = read("src-tauri/src/lib.rs");
const trayEvents = new Set([...tray.matchAll(/item\("ev:([a-z_]+)"/g)].map((match) => match[1]));
for (const event of trayEvents) {
  check(
    backendDemos.has(event) || event === "hotkey_song" || event === "quiet_hour",
    `Tray event ${event} is not routed by the backend`,
  );
}

const { ACTIONS, DANTE_ACTIONS } = loadTsModule("src/director.ts");
const directorStart = main.indexOf("function runCorvinClock()");
const directorEnd = main.indexOf("function runDanteClock()", directorStart);
const directorBody = directorStart >= 0 && directorEnd > directorStart
  ? main.slice(directorStart, directorEnd)
  : "";
const directorCases = new Set(
  [...directorBody.matchAll(/case\s+"([^"]+)"/g)].map((match) => match[1]),
);
for (const action of ACTIONS) check(directorCases.has(action.id), `Director action ${action.id} is not dispatched`);
const danteDirectorStart = directorEnd;
const danteDirectorEnd = main.indexOf("function scheduleDanteDirector()", danteDirectorStart);
const danteDirectorBody = danteDirectorStart >= 0 && danteDirectorEnd > danteDirectorStart
  ? main.slice(danteDirectorStart, danteDirectorEnd)
  : "";
const danteDirectorCases = new Set(
  [...danteDirectorBody.matchAll(/case\s+"([^"]+)"/g)].map((match) => match[1]),
);
for (const action of DANTE_ACTIONS) {
  check(danteDirectorCases.has(action.id), `Dante director action ${action.id} is not dispatched`);
}

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
notes.push(`${Object.keys(CORVIN).length} Corvin clips, ${declaredClips.size} named Dante clips`);
notes.push(`${backendDemos.size} demo triggers, ${ACTIONS.length + DANTE_ACTIONS.length} director actions`);
notes.push(`${spoken.size} Corvin story lines, ${Object.keys(voiceIndex).length} voice files`);

if (failures.length) {
  console.error(`Runtime audit failed (${failures.length}):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`Runtime audit passed: ${notes.join("; ")}.`);
