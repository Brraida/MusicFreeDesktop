const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { layout } = require("./build-info.cjs");

const build = layout();
if (build.platform !== "darwin") throw new Error("DMG creation requires a macOS runner");
const destination = path.join(build.root, "out/make", `MusicFree-${build.pkg.version}-${build.arch}.dmg`);
if (fs.existsSync(destination)) throw new Error("Refusing to overwrite " + destination);
fs.mkdirSync(path.dirname(destination), { recursive: true });
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "musicfree-dmg-"));
try {
    // ditto preserves framework symlinks, file modes and macOS application metadata.
    execFileSync("ditto", [path.join(build.directory, "MusicFree.app"), path.join(staging, "MusicFree.app")], { stdio: "inherit" });
    fs.symlinkSync("/Applications", path.join(staging, "Applications"));
    execFileSync("hdiutil", ["create", "-volname", "MusicFree", "-srcfolder", staging,
        "-fs", "HFS+", "-format", "UDZO", destination], { stdio: "inherit", timeout: 180000 });
    execFileSync("hdiutil", ["verify", destination], { stdio: "inherit", timeout: 60000 });
    console.log("Created and verified " + destination);
} finally {
    fs.rmSync(staging, { recursive: true, force: true });
}
