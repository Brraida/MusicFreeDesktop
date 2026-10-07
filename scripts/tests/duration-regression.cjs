const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { load, deferred } = require("./source-loader.cjs");
const time = load("src/common/time-util.ts");

(async () => {
    for (const [input, expected] of [[180.8, "03:00"], ["240", "04:00"], [" 03:08 ", "03:08"],
        ["1:02:03", "1:02:03"], [0, "00:00"], [" ", "--:--"], ["NaN", "--:--"],
        [NaN, "--:--"], [Infinity, "--:--"], [-2, "--:--"], ["03:99", "--:--"]]) {
        assert.equal(time.secondsToDuration(input), expected);
    }
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "musicfree-duration-"));
    try {
        const fileUtil = load("src/common/file-util.ts", {
            "./task-queue": load("src/common/task-queue.ts").default,
            "music-metadata": await import("music-metadata"),
            "./constant": load("src/common/constant.ts"),
            "./local-media": { isSupportedLocalMediaFile: () => true },
        });
        const wav = Buffer.alloc(44 + 16000 * 2 * 3);
        wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
        wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
        wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
        wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
        wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
        const file = path.join(folder, "duration.WAV"); await fs.writeFile(file, wav);
        assert.equal((await fileUtil.parseLocalMusicItem(file)).duration, 3, "Real imported WAV must preserve its duration");
        let exposed;
        const previousWindow = global.window;
        global.window = { addEventListener() {} };
        try {
            load("src/shared/utils/preload.ts", {
                electron: { contextBridge: { exposeInMainWorld: (_name, api) => {
                    exposed = api;
                } }, ipcRenderer: {} },
                "music-metadata": await import("music-metadata"),
                "@/common/download-file-system": { inspectDownloadFile() {} },
                "@/common/download-directory-watcher": { DownloadDirectoryWatcher: class {
                    async stop() {}
                } },
            });
        } finally {
            global.window = previousWindow;
        }
        assert.equal(await exposed.fs.getLocalMusicDuration(require("node:url").pathToFileURL(file).href),3,"Preload must read actual file URLs");
        assert.equal(await exposed.fs.getLocalMusicDuration(path.join(folder,"missing.mp3")),undefined);
        const tiny = path.join(folder,"tiny.mp3"); await fs.writeFile(tiny,Buffer.alloc(16));
        assert.equal(await exposed.fs.getLocalMusicDuration(tiny),undefined,"Tiny invalid files must safely use the buffer parser");
        await fs.unlink(tiny);
        const records = new Map();
        const table = { update: async (key, patch) => {
            const item = records.get(key.join("@"));
            if (item) Object.assign(item, patch);
            return item ? 1 : 0;
        } };
        let reads = 0, active = 0, peak = 0, pluginCalls = 0;
        const held = deferred();
        const resolver = load("src/renderer/core/music-duration.ts", {
            "p-queue": { default: (await import("p-queue")).default, __esModule: true },
            "@/common/time-util": time,
            "@/common/media-util": { getMediaPrimaryKey: item => item.platform + "@" + item.id },
            "@shared/utils/renderer": { fsUtil: { getLocalMusicDuration: async localPath => {
                reads++; active++; peak = Math.max(peak, active);
                try {
                    if (localPath === "held") return await held.promise;
                    await new Promise(resolve => setTimeout(resolve, 10));
                    return localPath === "missing" ? undefined : 180;
                } finally {
                    active--;
                }
            } } },
            "@shared/plugin-manager/renderer": { getSupportedPlugin: () => [{ platform: "online" }],
                callPluginDelegateMethod: async () => {
                    pluginCalls++; return { duration: "04:05" };
                } },
            "./db/music-sheet-db": { musicStore: table, localMusicStore: table, transaction: async (...args) => args.at(-1)() },
        });
        const song = { platform: "download", id: "song" }; records.set("download@song", { ...song, title: "Keep me", $$ref: 3 });
        assert.deepEqual(await Promise.all([resolver.resolveMusicDuration(song, file), resolver.resolveMusicDuration(song, file)]), [180,180]);
        assert.equal(reads,1,"Concurrent cells deduplicate the same metadata read");
        assert.equal(records.get("download@song").duration,180);
        assert.equal(records.get("download@song").$$ref,3,"Duration patch must preserve reference counts");
        await resolver.resolveMusicDuration(song,file); assert.equal(reads,1,"Changing playlists reuses the session cache");
        await resolver.resolveMusicDuration(song,"moved"); assert.equal(reads,2,"A changed local association must read the new path");
        const deleted = { platform:"download",id:"deleted" }; records.set("download@deleted",deleted);
        const pending = resolver.resolveMusicDuration(deleted,"held"); await new Promise(resolve=>setTimeout(resolve,20));
        records.delete("download@deleted"); held.resolve(190); await pending;
        assert(!records.has("download@deleted"),"Finishing metadata reads must not resurrect deleted songs");
        const values = await Promise.all(Array.from({ length:12 },(_,i)=>resolver.resolveMusicDuration({ platform:"download",id:"limited"+i },file)));
        assert(values.every(value=>value===180)); assert(peak<=3,"Metadata reads must have bounded concurrency");
        assert.equal(await resolver.resolveMusicDuration({ platform:"online",id:"info" }),245);
        assert.equal(pluginCalls,1,"Plugin details supply duration when available");
        assert.equal(await resolver.resolveMusicDuration({ platform:"unknown",id:"none" }),undefined,"Never invent missing duration");
        assert.equal(await resolver.resolveMusicDuration({ platform:"unknown",id:"file" },"missing"),undefined);
        console.log("PASS: real audio import duration, string formatting, cached local/download metadata, bounded reads, plugin details and safe persistence");
    } finally {
        await fs.rm(folder,{ recursive:true,force:true,maxRetries:5,retryDelay:100 });
    }
})().catch(error=>{
    console.error(error);process.exitCode=1;
});
