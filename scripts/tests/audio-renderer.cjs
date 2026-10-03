module.exports = async (_testRoot, base) => {
    const path = require("node:path");
    const assert = require("node:assert/strict");
    const req = require("node:module").createRequire(path.resolve("package.json"));
    const { load } = req("./scripts/tests/source-loader.cjs");
    const constants = load("src/common/constant.ts");
    window.path = path;
    const Hls = req("hls.js");
    const Controller = load("src/renderer/core/track-player/controller/audio-controller.ts", {
        "@/common/normalize-util": load("src/common/normalize-util.ts"), "@/assets/imgs/album-cover.jpg": "",
        "@/renderer/utils/get-url-ext": url => path.extname(new URL(url).pathname),
        "hls.js": { __esModule: true, default: Hls, Events: Hls.Events },
        "@/common/constant": constants,
        "@shared/service-manager/renderer": { RequestForwarderService: { forwardRequest: () => null } },
        "@renderer/core/track-player/controller/controller-base": load("src/renderer/core/track-player/controller/controller-base.ts").default,
        "@renderer/core/track-player/enum": load("src/renderer/core/track-player/enum.ts"), "@/common/void-callback": () => {},
    }).default;
    const controller = new Controller(), errors = [];
    controller.onError = (...args) => errors.push(args);
    const song = { id: "real-audio", platform: "test" };
    const until = async check => {
        const start = Date.now();
        while (!await check()) {
            if (Date.now() - start > 10000) throw new Error("Audio condition timed out");
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    };
    const protectedURL = base.replace("http://", "http://user:pass@") + "/protected.wav";
    controller.setTrackSource({ url: protectedURL }, song);
    controller.seekTo(0.5); controller.play();
    await until(() => controller.playerState === constants.PlayerState.Playing);
    assert.ok(controller.audio.currentTime >= 0.5); assert.equal(controller.audio.duration, 3);
    assert.equal(errors.length, 0);
    const blobURL = controller.audio.src;
    controller.reset(); await assert.rejects(() => fetch(blobURL));
    controller.setTrackSource({ url: protectedURL.replace("protected", "protected-slow") }, song);
    controller.play(); controller.pause();
    await until(() => controller.hasSource);
    assert.equal(controller.audio.paused, true);
    controller.setTrackSource({ url: base + "/manifest.m3u8" }, song); controller.play();
    await until(async () => (await (await fetch(base + "/stats")).json())["/segment.ts"] > 0);
    const hls = controller.hls;
    controller.setTrackSource({ url: base + "/direct.wav" }, { ...song, id: "direct" }); controller.play();
    await until(() => controller.playerState === constants.PlayerState.Playing);
    assert.equal(controller.hls, null); assert.equal(hls.media, null);
    assert.equal(controller.audio.duration, 3); assert.equal(errors.length, 0);
    controller.destroy();
    return "PASS: actual Windows HTMLAudio decodes authenticated Blob WAV, retains play/seek/pause, revokes Blob, aborts real HLS fragment and plays direct WAV";
};
