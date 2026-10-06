module.exports = async () => {
    const assert = require("node:assert/strict");
    const fs = require("node:fs"), path = require("node:path");
    const { pathToFileURL } = require("node:url");
    const req = require("node:module").createRequire(path.resolve("package.json"));
    const { load } = req("./scripts/tests/source-loader.cjs");
    const React = req("react"), ReactDOM = req("react-dom/client"), { act } = req("react-dom/test-utils");
    const sass = req("sass");
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const h = React.createElement;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const constants = load("src/common/constant.ts");
    const layout = load("src/common/lyric-layout.ts");
    const Parser = load("src/renderer/utils/lyric-parser.ts").default;
    const derive = load("src/renderer/utils/lyric-pair.ts");
    const config = { "lyric.fontSize": 54, "lyric.fontData": { family: "Microsoft YaHei" },
        "lyric.fontColor": layout.LYRIC_LAYOUT.color, "lyric.strokeColor": layout.LYRIC_LAYOUT.stroke,
        "lyric.lockLyric": false };
    const configListeners = new Set();
    const AppConfig = { getConfig: key => config[key],
        onConfigUpdate: cb => configListeners.add(cb), offConfigUpdate: cb => configListeners.delete(cb),
        setConfig(patch) {
            Object.assign(config, patch); for (const cb of configListeners) cb(patch, config);
        } };
    const subscribers = new Set(), commands = [], windowCalls = [];
    let appState = {};
    let delivered;
    const channel = new MessageChannel();
    channel.port2.onmessage = event => {
        const patch = event.data;
        appState = { ...appState, ...patch };
        for (const cb of subscribers) cb(appState, patch);
        delivered?.();
    };
    window["@shared/message-bus/extension"] = { getAppState: () => appState,
        onStateChange: cb => subscribers.add(cb), offStateChange: cb => subscribers.delete(cb),
        sendCommand: command => commands.push(command), subscribeAppState() {} };
    const extension = load("src/shared/message-bus/renderer/extension.ts");
    const usePair = load("src/renderer/utils/use-lyric-pair.ts", {
        "@shared/message-bus/renderer/extension": extension, "./lyric-pair": derive,
    }).default;
    const useConfig = load("src/hooks/useAppConfig.ts", { "@shared/app-config/renderer": AppConfig }).default;
    const language = JSON.parse(fs.readFileSync("res/lang/zh-CN.json", "utf8"));
    const translations = { useTranslation: () => ({ t: key => key.split(".").reduce((value, part) => value?.[part], language) || key }) };
    const Svg = ({ iconName }) => h("svg", { "data-icon": iconName, viewBox: "0 0 24 24" },
        h("path", { d: iconName === "pause" ? "M7 5V19M17 5V19" : "M7 5L18 12L7 19Z", stroke: "currentColor", fill: "none", strokeWidth: 2 }));
    const assets = name => pathToFileURL(path.resolve("src/assets/imgs", name)).href;
    const Vinyl = load("src/renderer/components/VinylCover/index.tsx", { "./index.scss": {},
        "@/assets/imgs/album-cover.jpg": assets("album-cover.jpg"),
        "@/assets/imgs/vinyl-tonearm-real-v1.png": assets("vinyl-tonearm-real-v1.png"),
        "@/assets/imgs/vinyl-record-real-v1.png": assets("vinyl-record-real-v1.png"),
    }).default;
    const shared = { "@/renderer/utils/use-lyric-pair": usePair, "@/common/constant": constants,
        "@/renderer/components/SvgAsset": Svg, "react-i18next": translations,
        "@shared/message-bus/renderer/extension": extension,
        "@shared/utils/renderer": { appWindowUtil: {
            showMainWindow: () => windowCalls.push("show"), setMinimodeWindow: value => windowCalls.push(value),
            setLyricWindow() {}, ignoreMouseEvent() {},
        } } };
    const Desktop = load("src/renderer-lrc/pages/index.tsx", { ...shared, "./index.scss": {},
        "@/renderer/utils/classnames": load("src/renderer/utils/classnames.ts").default,
        "@/common/lyric-layout": layout, "@/hooks/useAppConfig": useConfig,
        "@shared/app-config/renderer": AppConfig,
        "@/renderer/components/Condition": load("src/renderer/components/Condition/index.tsx").default,
    }).default;
    const Mini = load("src/renderer-minimode/pages/index.tsx", { ...shared, "./index.scss": {},
        "@/assets/imgs/album-cover.jpg": assets("album-cover.jpg"), "@/renderer/components/VinylCover": Vinyl,
        "@/common/media-util": { getMediaPrimaryKey: item => item.platform + ":" + item.id },
    }).default;
    const nativeObserver = window.ResizeObserver, observers = new Set();
    window.ResizeObserver = class extends nativeObserver {
        constructor(cb) {
            super(cb); observers.add(this);
        }
        disconnect() {
            observers.delete(this); super.disconnect();
        }
    };
    const style = document.createElement("style");
    style.textContent = ["src/renderer-lrc/pages/index.scss", "src/renderer-minimode/pages/index.scss",
        "src/renderer/components/VinylCover/index.scss", "src/shared/themepack/jiangnan.scss"]
        .map(file => sass.compile(path.resolve(file), { logger: sass.Logger.silent }).css)
        .join("\n").replaceAll("../../assets/imgs/", assets("") + "/")
        + `body{margin:28px;background:#f7fafb;font-family:'Microsoft YaHei',sans-serif;color:#24485c}
        h2{font-size:20px;margin:16px 0}.lyric-fixture{width:920px;background:linear-gradient(125deg,#142e3f,#25434a);border-radius:12px}
        .mini-fixture{margin-top:12px;position:relative;width:340px;height:72px;overflow:hidden;border-radius:10px}
        .fixture-caption{font-size:13px;color:#667b89}`;
    document.head.append(style);
    document.documentElement.dataset.builtinTheme = "jiangnan";
    const view = ReactDOM.createRoot(document.getElementById("test-root"));
    async function update(patch) {
        await act(async () => {
            await new Promise(resolve => {
                delivered = resolve; channel.port1.postMessage(patch);
            });
        });
        await frame();
    }
    async function setFont(font) {
        await act(async () => {
            document.querySelector(".lyric-fixture").style.height = layout.lyricWindowHeight(font) + "px";
            AppConfig.setConfig({ "lyric.fontSize": font });
        });
        await frame();
    }
    const song = { id: "lyric-A", platform: "test", title: "微光", artist: "示例歌手" };
    const parser = new Parser("[00:05]把这一刻唱给你听\n[00:10]把这一刻唱给你听\n[00:15]让晚风接住我们的声音\n[00:20]\n[00:25]直到星光落在心里");
    const snapshot = (source, time) => ({ fullLyric: source.getLyricItems(), parsedLrc: source.getPosition(time),
        lyricHasTimeline: source.hasTimeTags, lyricOffset: source.getMeta().offset || 0, progress: time, duration: 40 });
    await update({ musicItem: song, playerState: constants.PlayerState.Playing, ...snapshot(parser, 0) });
    await act(async () => view.render(h(React.Fragment, null,
        h("h2", null, "桌面歌词 · 真实组件"), h("div", { className: "lyric-fixture", style: { height: layout.lyricWindowHeight(54) } }, h(Desktop)),
        h("h2", null, "迷你窗口 · 340 × 72"), h("div", { className: "mini-fixture" }, h(Mini)),
        h("p", { className: "fixture-caption" }, "当前开发组件的 Windows Chromium 截图 / 原创示例歌词"))));
    const deskCurrent = () => document.querySelector(".lyric-current-row");
    const deskNext = () => document.querySelector(".lyric-next-row");
    const miniCurrent = () => document.querySelector(".mini-current-lyric");
    const miniNext = () => document.querySelector(".mini-next-lyric");
    const text = element => element.textContent.trim();
    function paired(current, next) {
        assert.equal(text(deskNext()), next); assert.equal(text(miniNext()), next);
        if (current) {
            assert.equal(text(deskCurrent()), current); assert.equal(text(miniCurrent()), current);
        }
    }
    paired(null, "把这一刻唱给你听");
    await update(snapshot(parser, 5)); paired("把这一刻唱给你听", "把这一刻唱给你听");
    await update(snapshot(parser, 10)); paired("把这一刻唱给你听", "让晚风接住我们的声音");
    await update({ playerState: constants.PlayerState.Paused });
    await wait(100); paired("把这一刻唱给你听", "让晚风接住我们的声音");
    await update(snapshot(parser, 0)); paired(null, "把这一刻唱给你听");
    assert(text(deskCurrent()).includes(song.title));
    await update(snapshot(parser, 21)); paired("间奏", "直到星光落在心里");
    await update(snapshot(parser, 25)); paired("直到星光落在心里", "");
    assert.equal(getComputedStyle(deskNext()).visibility, "hidden");
    assert(deskNext().getBoundingClientRect().height > 0, "Last line must reserve the second-row space");
    const long = "让这一段很长很长的晚风陪我们穿过灯火再迎接新的清晨".repeat(3);
    const longParser = new Parser("[00:05]把这一刻唱给你听\n[00:10]" + long + "\n[00:30]最后一句");
    await update({ ...snapshot(longParser, 5), playerState: constants.PlayerState.Playing });
    paired("把这一刻唱给你听", long);
    assert(deskNext().classList.contains("lyric-overflow"));
    const animation = deskNext().querySelector("span").getAnimations()[0]; assert(animation);
    await update({ playerState: constants.PlayerState.Paused }); await wait(30);
    const stopped = animation.currentTime; await wait(120); assert(Math.abs(animation.currentTime - stopped) < 1);
    await update({ playerState: constants.PlayerState.Playing }); await wait(100); assert(animation.currentTime > stopped);
    await update(snapshot(longParser, 25));
    assert.notEqual(getComputedStyle(deskCurrent().querySelector("span")).transform, "matrix(1, 0, 0, 1, 0, 0)");
    await update(snapshot(longParser, 10));
    assert.equal(getComputedStyle(deskCurrent().querySelector("span")).transform, "matrix(1, 0, 0, 1, 0, 0)", "Backward seek resets the long-line scroll");
    const miniBounds = document.querySelector(".mini-fixture").getBoundingClientRect();
    for (const element of [miniCurrent(), miniNext()]) {
        const rect = element.getBoundingClientRect();
        assert(rect.top >= miniBounds.top && rect.bottom <= miniBounds.bottom);
        assert.equal(getComputedStyle(element).whiteSpace, "nowrap");
    }
    assert.equal(miniCurrent().title, long);
    for (const font of [16, 54, 80]) {
        await setFont(font);
        const content = document.querySelector(".content-container").getBoundingClientRect();
        const pair = document.querySelector(".lyric-pair").getBoundingClientRect();
        assert(pair.top >= content.top - 1 && pair.bottom <= content.bottom + 1, "Two lines clipped at font " + font);
    }
    await setFont(54);
    const plain = new Parser("没有时间轴\n不能伪造下一句");
    await update(snapshot(plain, 0)); assert.equal(text(deskNext()), ""); assert(text(deskCurrent()).includes(song.title));
    const changed = { ...song, id: "B", title: "另一首歌" };
    await update({ musicItem: changed, fullLyric: [], parsedLrc: null, lyricHasTimeline: false, progress: 0 });
    assert(text(deskCurrent()).includes(changed.title)); assert.equal(text(miniCurrent()), changed.title);
    assert.equal(text(deskNext()), "");
    await update({ ...snapshot(parser, 5), musicItem: song });
    const record = document.querySelector(".vinyl-record");
    document.querySelector(".album-container").focus(); await frame();
    assert.equal(getComputedStyle(document.querySelector(".options-container")).visibility, "visible");
    paired("把这一刻唱给你听", "把这一刻唱给你听");
    for (const button of document.querySelectorAll(".options-container .option-item")) button.click();
    assert.deepEqual(commands, ["SkipToPrevious", "TogglePlayerState", "SkipToNext"]);
    document.querySelector(".options-container .close-button").click(); assert.deepEqual(windowCalls, [false, "show"]);
    assert.equal(document.querySelector(".vinyl-record"), record, "Hover must not recreate the record");
    document.activeElement?.blur();
    window.lyricPreviewMode = async mode => {
        const source = mode === "long" ? longParser : parser;
        await update({ musicItem: song, ...snapshot(source, mode === "last" ? 25 : mode === "long" ? 5 : 10),
            playerState: constants.PlayerState.Playing });
        await wait(180); await frame();
    };
    window.lyricFinish = async () => {
        await act(async () => view.unmount());
        assert.equal(subscribers.size, 0); assert.equal(configListeners.size, 0); assert.equal(observers.size, 0);
        channel.port1.close(); channel.port2.close(); window.ResizeObserver = nativeObserver;
        delete window["@shared/message-bus/extension"]; style.remove();
    };
    return "PASS: actual React/SCSS with MessageChannel snapshots, paired windows, repeated text, intro/backward seek, pause/resume, blank/last/plain text, long-line scrolling, fonts 16/54/80, 340x72 clip checks, hover/focus controls, stable record; cleanup and reduced motion checked by main runner";
};
