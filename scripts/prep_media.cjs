// Build-time step: the repo carries the poster gif under its REAL name only.
// The app's bundled fallback needs public/media/poster.gif, so we rename-copy
// the first non-poster gif here before every build. poster.gif is gitignored.
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "public", "media");
if (fs.existsSync(dir)) {
  const gif = fs
    .readdirSync(dir)
    .find((f) => f.toLowerCase().endsWith(".gif") && f.toLowerCase() !== "poster.gif");
  if (gif) {
    fs.copyFileSync(path.join(dir, gif), path.join(dir, "poster.gif"));
    console.log(`[prep_media] poster.gif <- ${gif}`);
  } else if (!fs.existsSync(path.join(dir, "poster.gif"))) {
    console.warn("[prep_media] no gif found in public/media — poster will be empty");
  }
}
