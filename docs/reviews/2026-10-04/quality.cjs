// Diagnostic reproduction for R5 at 4e7b711. Reuses the existing test fixture.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const fixture = path.resolve(__dirname, "../../../scripts/tests/player-regression.cjs");
const prefix = fs.readFileSync(fixture, "utf8").split("(async () => {")[0];
const { createPlayer, deferred, source } = new Function("require", prefix + "\nreturn { createPlayer, deferred, source };")(createRequire(fixture));
(async () => {
    const { player } = createPlayer();
    player.fetchCurrentLyric = async () => {};
    const held = deferred();
    player.fetchMediaSource = (_song, quality) => quality === "high"
        ? Promise.resolve(source("high-url", "high")) : held.promise;
    const playing = player.playIndex(0);
    let playCalls = 0;
    player.audioController.play = () => playCalls++;
    await player.setQuality("high");
    held.resolve(source("initial-url"));
    await playing;
    console.log(JSON.stringify({ playCalls, state: player.playerState, quality: player.currentQuality,
        tracks: player.audioController.tracks }, null, 2));
    assert.equal(playCalls, 0, "reproduced: changing quality during initial loading loses autoplay");
})().catch(error => { console.error(error); process.exitCode = 1; });
