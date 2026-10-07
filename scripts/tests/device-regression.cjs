const assert = require("node:assert/strict");
const { load, deferred } = require("./source-loader.cjs");
const descriptor = Object.getOwnPropertyDescriptor(global, "navigator");
const output = (id, groupId = id) => ({ kind: "audiooutput", deviceId: id, groupId });
const A = output("A"), B = output("B"), microphone = { kind: "audioinput", deviceId: "mic" };
const turn = () => new Promise(resolve => setImmediate(resolve));

async function probe(initial, selected = "A", policy = "pause") {
    let devices = initial, paused = 0;
    const mediaDevices = { enumerateDevices: async () => devices };
    Object.defineProperty(global, "navigator", { configurable: true, value: { mediaDevices } });
    const empty = Object.fromEntries(["../core/music-sheet", "../core/local-music", "../core/downloader", "@/shared/i18n/renderer",
        "@/shared/themepack/renderer", "../core/recently-playlist", "@shared/service-manager/renderer", "@shared/utils/renderer",
        "@shared/plugin-manager/renderer", "@shared/message-bus/renderer/main", "@renderer/components/MusicDetail",
        "@shared/short-cut/renderer", "@shared/logger/renderer", "@shared/themepack/builtin", "@/common/local-media"].map(name => [name, {}]));
    const api = load("src/renderer/document/bootstrap.ts", { ...empty,
        "@/common/constant": load("src/common/constant.ts"), "@renderer/core/track-player/enum": {},
        "../core/track-player": { pause: () => ++paused }, immer: { setAutoFreeze() {} },
        "@shared/app-config/renderer": { getConfig: key => key === "playMusic.audioOutputDevice" ? { deviceId: selected } : policy },
    }, "\nexport { setupDeviceChange };");
    await api.setupDeviceChange();
    return { paused: () => paused, mediaDevices, change: async next => {
        devices = next; mediaDevices.ondevicechange(); await turn();
    } };
}
(async () => {
    try {
        let test = await probe([A, microphone]); await test.change([A]); assert.equal(test.paused(), 0);
        test = await probe([A, B]); await test.change([A]); assert.equal(test.paused(), 0);
        test = await probe([A]); await test.change([B]); assert.equal(test.paused(), 1, "Same-count output replacement must be detected");
        test = await probe([A], "A", "play"); await test.change([B]); assert.equal(test.paused(), 0);
        test = await probe([output("default", "A"), A, B], "default");
        await test.change([output("default", "B"), A, B]); assert.equal(test.paused(), 1, "Default sink identity changed without count change");
        test = await probe([A]); const late = deferred(); let calls = 0;
        test.mediaDevices.enumerateDevices = () => ++calls === 1 ? late.promise : Promise.resolve([B]);
        test.mediaDevices.ondevicechange(); test.mediaDevices.ondevicechange(); await turn();
        assert.equal(test.paused(), 1); late.resolve([A]); await turn();
        test.mediaDevices.ondevicechange(); await turn(); assert.equal(test.paused(), 1, "Late enumeration must not restore a removed output");
        test = await probe([A]); const original = console.error; console.error = () => {};
        try {
            test.mediaDevices.enumerateDevices = async () => {
                throw new Error("Permission denied");
            };
            test.mediaDevices.ondevicechange(); await turn(); assert.equal(test.paused(), 0);
        } finally {
            console.error = original;
        }
        test.mediaDevices.enumerateDevices = async () => [B]; test.mediaDevices.ondevicechange(); await turn(); assert.equal(test.paused(), 1);
        console.log("PASS: selected/default output identity, same-count replacement, unrelated input/output removal, play policy, stale enumeration and permission failure");
    } finally {
        if (descriptor) Object.defineProperty(global, "navigator", descriptor); else delete global.navigator;
    }
})().catch(error => {
    console.error(error); process.exitCode = 1;
});
