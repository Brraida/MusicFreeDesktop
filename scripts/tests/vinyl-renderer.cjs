module.exports = async (testRoot) => {
    const fs = require("node:fs"), path = require("node:path");
    const { pathToFileURL } = require("node:url");
    const assert = require("node:assert/strict");
    const req = require("node:module").createRequire(path.resolve("package.json"));
    const { load } = req("./scripts/tests/source-loader.cjs");
    const React = req("react"), ReactDOM = req("react-dom/client");
    const { act } = req("react-dom/test-utils");
    const sass = req("sass");
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const h = React.createElement;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const until = async (check) => {
        const deadline = Date.now() + 5000;
        while (!check()) {
            assert(Date.now() < deadline, "Visual condition timed out");
            await wait(30);
        }
    };
    const style = document.createElement("style");
    const styles = ["src/renderer/components/VinylCover/index.scss", "src/renderer/components/MusicDetail/index.scss",
        "src/renderer/components/MusicBar/widgets/MusicInfo/index.scss", "src/renderer-minimode/pages/index.scss",
        "src/renderer/components/MusicDetail/widgets/Lyric/index.scss"];
    style.textContent = styles.map(file => sass.compile(path.resolve(file), { logger: sass.Logger.silent }).css).join("\n")
        + fs.readFileSync(req.resolve("animate.css"), "utf8")
        + `:root{font-size:13px;--appMusicBarHeight:64px;--primaryColor:#5eead4;--dividerColor:#fff2;--linkColor:#5eead4}
        body{margin:16px;background:#121923;color:#edf1f7;font-family:'Microsoft YaHei',sans-serif}
        .background-color{background:#1b2530}.animate__animated{--animate-duration:.2s}
        .test-detail{width:1050px;height:600px;position:relative;border-radius:12px;overflow:hidden}
        .test-bar{margin-top:20px;height:64px;width:1050px;display:flex;align-items:center;background:#1b2530;border-radius:8px}
        .test-mini{margin-top:20px;width:340px;height:72px;position:relative;overflow:hidden;border-radius:6px}
        .test-lyric{display:flex;flex-direction:column;justify-content:center;text-align:center;gap:24px}
        .test-lyric strong{color:#5eead4;font-size:22px}.test-lyric span{color:#a4afbb;font-size:18px}
        .test-caption{font-size:13px;color:#a4afbb;margin:10px 0}.test-bar-controls{display:flex;gap:32px;align-items:center;margin-left:80px}
        svg[data-icon]{width:22px;height:22px}button{color:inherit;background:none;border:0}`;
    document.head.append(style);
    // The fixture changes Page Visibility explicitly instead of relying on a hidden test window.
    let visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const constants = load("src/common/constant.ts");
    const media = load("src/common/media-util.ts", { "./constant": constants });
    const Store = load("src/common/store.ts").default;
    const stores = load("src/renderer/core/track-player/store.ts", { "@/common/store": Store, "@/common/constant": constants }).default;
    const hooks = load("src/renderer/core/track-player/hooks.ts", { "@renderer/core/track-player/store": stores });
    const detailStore = load("src/renderer/components/MusicDetail/store.ts", { "@/common/store": Store });
    const fallback = pathToFileURL(path.resolve("src/assets/imgs/album-cover.jpg")).href;
    const tonearmPath = path.resolve("src/assets/imgs/vinyl-tonearm-real-v1.png");
    const recordPath = path.resolve("src/assets/imgs/vinyl-record-real-v1.png");
    const tonearmUrl = pathToFileURL(tonearmPath).href;
    const recordUrl = pathToFileURL(recordPath).href;
    const vinylModule = load("src/renderer/components/VinylCover/index.tsx", {
        "./index.scss": {}, "@/assets/imgs/album-cover.jpg": fallback,
        "@/assets/imgs/vinyl-tonearm-real-v1.png": tonearmUrl,
        "@/assets/imgs/vinyl-record-real-v1.png": recordUrl,
    });
    const VinylCover = vinylModule.default, geometry = vinylModule.tonearmGeometry;
    const { nativeImage } = req("electron");
    const sprite = nativeImage.createFromPath(tonearmPath);
    assert.deepEqual(sprite.getSize(), { width: geometry.width, height: geometry.height });
    const pixels = sprite.toBitmap();
    const alpha = (x, y) => pixels[(y * geometry.width + x) * 4 + 3];
    assert(alpha(geometry.needle.x, geometry.needle.y) > 32, "Needle anchor must correspond to visible sprite pixels");
    const armBoundary = [];
    for (let y = 0; y < geometry.height; y++) {
        let left = -1, right = -1;
        for (let x = 0; x < geometry.width; x++) {
            if (alpha(x, y) > 32) {
                if (left < 0) left = x; right = x;
            }
        }
        if (left >= 0) armBoundary.push({ x: left, y }, { x: right, y });
    }
    assert(armBoundary.length > 100, "Tonearm sprite must contain visible hardware");
    for (const asset of [tonearmPath, recordPath]) {
        const image = new Image(); image.src = pathToFileURL(asset).href; await image.decode();
        const bitmap = nativeImage.createFromPath(asset), size = bitmap.getSize(), buffer = bitmap.toBitmap();
        for (const index of [0, size.width - 1, size.width * (size.height - 1), size.width * size.height - 1]) {
            assert.equal(buffer[index * 4 + 3], 0, "Material asset must have a transparent background");
        }
    }
    const translation = { useTranslation: () => ({ t: key => key }) };
    const Svg = ({ iconName }) => h("svg", { "data-icon": iconName, viewBox: "0 0 24 24" },
        h("path", { d: iconName === "pause" ? "M7 5V19M17 5V19" : "M7 5L18 12L7 19Z", fill: "none", stroke: "currentColor", strokeWidth: 2 }));
    const Tag = ({ children }) => h("small", null, children);
    const Lyric = () => h("div", { className: "lyric-container-outer test-lyric" },
        h("span", null, "城市慢慢安静"), h("strong", null, "让旋律陪伴此刻"), h("span", null, "把心事交给夜色"));
    const AnimatedDiv = load("src/renderer/components/AnimatedDiv/index.tsx").default;
    const Detail = load("src/renderer/components/MusicDetail/index.tsx", {
        "../AnimatedDiv": AnimatedDiv, "./index.scss": {}, "@/assets/imgs/album-cover.jpg": fallback,
        "../Tag": Tag, "./widgets/Header": () => h("div", null), "./widgets/Lyric": Lyric,
        "../Condition": load("src/renderer/components/Condition/index.tsx").default,
        "react-i18next": translation, "@renderer/core/track-player/hooks": hooks,
        "@/common/constant": constants, "@/common/media-util": media, "@/renderer/components/VinylCover": VinylCover,
        "@renderer/components/MusicDetail/store": detailStore,
    });
    const Info = load("src/renderer/components/MusicBar/widgets/MusicInfo/index.tsx", {
        "./index.scss": {}, "@/renderer/components/SvgAsset": Svg, "@/renderer/components/Tag": Tag,
        "@/common/time-util": load("src/common/time-util.ts"), "@/renderer/components/MusicFavorite": () => h("span", null, "♡"),
        "@/renderer/components/MusicDetail": Detail, "react-i18next": translation, "@renderer/core/track-player/hooks": hooks,
        "@/renderer/components/VinylCover": VinylCover,
        "@/common/constant": constants, "@/common/media-util": media,
        "@renderer/components/Panel": { hidePanel() {}, showPanel() {} }, "@renderer/components/MusicDownloaded": () => null,
        "@shared/plugin-manager/renderer": { isSupportFeatureMethod: () => false },
    }).default;
    let appState = {}, showMain = 0;
    const subscribers = new Set(), commands = [];
    window["@shared/message-bus/extension"] = {
        getAppState: () => appState, onStateChange: cb => subscribers.add(cb), offStateChange: cb => subscribers.delete(cb),
        subscribeAppState: () => {}, sendCommand: command => commands.push(command),
    };
    const extension = load("src/shared/message-bus/renderer/extension.ts");
    const useLyricPair = load("src/renderer/utils/use-lyric-pair.ts", {
        "@shared/message-bus/renderer/extension": extension,
        "./lyric-pair": load("src/renderer/utils/lyric-pair.ts"),
    }).default;
    const Mini = load("src/renderer-minimode/pages/index.tsx", {
        "@/renderer/utils/use-lyric-pair": useLyricPair,
        "./index.scss": {}, "@/renderer/components/SvgAsset": Svg, "@/common/constant": constants,
        "@/assets/imgs/album-cover.jpg": fallback, "@/renderer/components/VinylCover": VinylCover,
        "@/common/media-util": media, "react-i18next": translation,
        "@/renderer/utils/user-perference": { useUserPreference: () => [false] },
        "@shared/utils/renderer": { appWindowUtil: { showMainWindow: () => ++showMain, setMinimodeWindow() {} } },
        "@shared/message-bus/renderer/extension": extension,
    }).default;
    const art = encodeURIComponent("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"512\" height=\"512\"><defs><linearGradient id=\"sky\" x2=\"0\" y2=\"1\"><stop stop-color=\"#163f52\"/><stop offset=\"1\" stop-color=\"#69aeb5\"/></linearGradient></defs><rect width=\"512\" height=\"512\" fill=\"url(#sky)\"/><circle cx=\"380\" cy=\"100\" r=\"35\" fill=\"#efe9d1\"/><path d=\"M0 310L160 100L285 280L370 190L512 330V512H0\" fill=\"#24485c\"/><path d=\"M112 165L160 100L205 170L168 153L150 169Z\" fill=\"#b1ccd3\"/><path d=\"M0 365Q180 335 512 370V512H0\" fill=\"#257284\"/><path d=\"M70 420Q250 385 450 425M140 453H405\" stroke=\"#79bfc5\" fill=\"none\" stroke-width=\"3\"/><text x=\"256\" y=\"478\" text-anchor=\"middle\" fill=\"#ecf4f1\" font-size=\"32\">夜色微光</text></svg>");
    const songA = { id: "A", platform: "test", title: "夜色微光", artist: "示例歌手", album: "示例专辑", artwork: "data:image/svg+xml," + art };
    const songB = { ...songA, id: "B", title: "另一首歌" };
    async function update(patch) {
        await act(async () => {
            if ("musicItem" in patch) stores.currentMusicStore.setValue(patch.musicItem);
            if ("playerState" in patch) stores.playerStateStore.setValue(patch.playerState);
            appState = { ...appState, ...patch };
            for (const cb of subscribers) cb(appState, patch);
        });
        await frame();
    }
    const scene = () => h(React.Fragment, null,
        h("p", { className: "test-caption" }, "歌曲详情 · 真实组件 / 示例数据"),
        h("section", { className: "test-detail" }, h(Detail.default)),
        h("section", { className: "test-bar" }, h(Info), h("div", { className: "test-bar-controls" }, "◀", "❚❚", "▶", "01:28 / 04:16")),
        h("p", { className: "test-caption" }, "迷你窗口 · 340 × 72"), h("section", { className: "test-mini" }, h(Mini)));
    const view = ReactDOM.createRoot(document.getElementById("test-root"));
    await update({ musicItem: songA, playerState: constants.PlayerState.Playing });
    await act(async () => {
        detailStore.musicDetailShownStore.setValue(true);
        stores.progressStore.setValue({ currentTime: 88, duration: 256 });
        view.render(scene());
    });
    await wait(350); await frame();
    const detail = () => document.querySelector(".music-album.vinyl-cover");
    const bar = () => document.querySelector(".music-cover.vinyl-cover");
    const mini = () => document.querySelector(".album-container.vinyl-cover");
    const record = cover => cover.querySelector(".vinyl-record");
    const animation = cover => record(cover).getAnimations()[0];
    function assertArmFits(cover) {
        const bounds = cover.getBoundingClientRect();
        // Use the sprite's actual alpha boundary, not the empty image rectangle.
        const shape = cover.querySelector(".vinyl-arm-texture");
        for (const point of armBoundary) {
            const screen = new DOMPoint(point.x, point.y).matrixTransform(shape.getScreenCTM());
            assert(screen.x >= bounds.left - 1 && screen.x <= bounds.right + 1
                && screen.y >= bounds.top - 1 && screen.y <= bounds.bottom + 1,
            `Tonearm sprite clipped: ${screen.x - bounds.left}, ${screen.y - bounds.top} in ${bounds.width}`);
        }
    }
    function assertStylusPosition(cover, playing) {
        const vinyl = record(cover), bounds = cover.getBoundingClientRect();
        const center = { x: bounds.left + vinyl.offsetLeft + vinyl.offsetWidth / 2,
            y: bounds.top + vinyl.offsetTop + vinyl.offsetHeight / 2 };
        const radius = vinyl.offsetWidth / 2;
        const stylus = cover.querySelector(".vinyl-arm-texture");
        const tip = geometry.needle;
        const screen = new DOMPoint(tip.x, tip.y).matrixTransform(stylus.getScreenCTM());
        const distance = Math.hypot(screen.x - center.x, screen.y - center.y);
        if (playing) {
            assert(distance > radius * 0.54 + 0.3 && distance < radius - 0.3, "Stylus must land on the black groove, outside the artwork");
            assert(screen.x > center.x && screen.y > center.y, "Stylus must land in the lower-right quadrant");
        } else {
            assert(distance > radius + 0.3, "Resting stylus must clear the record");
        }
    }
    for (const cover of [detail(), bar(), mini()]) {
        assert(cover, "A player context is missing its vinyl cover");
        await cover.querySelector("img").decode();
        assert.equal(getComputedStyle(cover.querySelector("img")).borderRadius, "50%");
        assert.equal(cover.dataset.playing, "true");
        assertArmFits(cover);
        assertStylusPosition(cover, true);
    }
    assert.equal(getComputedStyle(bar()).width, "44px");
    assert.equal(getComputedStyle(mini()).width, "56px");
    assert.equal(bar().dataset.spinning, "false", "Hidden bottom cover must not keep spinning");
    assert.equal(animation(mini()).effect.getTiming().duration, 20000);
    const turning = getComputedStyle(record(mini())).transform;
    await wait(200);
    assert.notEqual(getComputedStyle(record(mini())).transform, turning, "Record did not rotate");
    assert.equal(bar().dataset.compact, "true");
    assert.equal(mini().dataset.compact, "true");
    assert.equal(detail().dataset.compact, "false");
    for (const cover of [detail(), bar(), mini()]) {
        assert.equal(cover.querySelector(".vinyl-arm-texture").href.baseVal, tonearmUrl);
        assert(getComputedStyle(cover.querySelector(".vinyl-sheen")).backgroundImage.includes("vinyl-record-real-v1.png"));
    }
    const sheen = mini().querySelector(".vinyl-sheen");
    assert.equal(sheen.getAnimations().length, 0, "Lighting must not rotate with the grooves");
    const savedRecord = record(mini());
    await update({ playerState: constants.PlayerState.Paused });
    await wait(500);
    const stoppedAt = animation(mini()).currentTime;
    const stoppedTransform = getComputedStyle(savedRecord).transform;
    await wait(200);
    assert.equal(animation(mini()).playState, "paused");
    assert(Math.abs(animation(mini()).currentTime - stoppedAt) < 1, "Paused record lost its angle");
    assert.equal(getComputedStyle(savedRecord).transform, stoppedTransform);
    assert.notEqual(getComputedStyle(mini().querySelector(".vinyl-arm-moving")).transform, "matrix(1, 0, 0, 1, 0, 0)");
    for (const cover of [detail(), bar(), mini()]) {
        assertArmFits(cover);
        assertStylusPosition(cover, false);
    }
    await update({ playerState: constants.PlayerState.Playing });
    await wait(180);
    assert.equal(record(mini()), savedRecord, "Resume recreated the spinning record");
    assert(animation(mini()).currentTime > stoppedAt, "Resume restarted rather than continued");
    await act(async () => {
        visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
    });
    await frame();
    assert.equal(mini().dataset.spinning, "false");
    const hiddenAt = animation(mini()).currentTime;
    await wait(160); assert(Math.abs(animation(mini()).currentTime - hiddenAt) < 1);
    await act(async () => {
        visibility = "visible"; document.dispatchEvent(new Event("visibilitychange"));
    });
    await frame(); assert.equal(mini().dataset.spinning, "true");
    await update({ musicItem: songB, playerState: constants.PlayerState.Buffering });
    assert.notEqual(record(mini()), savedRecord, "Switching songs kept the previous record");
    assert.equal(mini().dataset.spinning, "false");
    assert.equal(mini().querySelector("img").alt, "另一首歌");
    assert.equal(animation(mini()).currentTime, 0);
    await update({ musicItem: { ...songB, artwork: pathToFileURL(path.join(testRoot, "missing-cover.jpg")).href } });
    await until(() => mini().querySelector("img").dataset.fallback === "true");
    await mini().querySelector("img").decode();
    assert.equal(mini().querySelector("img").src, fallback, "Broken cover did not fall back");
    await update({ musicItem: songA, playerState: constants.PlayerState.Playing });
    await act(async () => detailStore.musicDetailShownStore.setValue(false));
    await wait(300); await frame();
    assert.equal(detail(), null, "Closing detail failed to unmount");
    assert.equal(bar().dataset.spinning, "true");
    await act(async () => bar().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await wait(300);
    assert(detail(), "Keyboard cover interaction did not open details");
    await act(async () => mini().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    assert.equal(showMain, 1);
    await act(async () => document.querySelector(".minimode-header-container").dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    const toggle = document.querySelector(".options-container .option-item:nth-of-type(2)");
    assert(toggle, "Mini controls lost their hover behavior");
    await act(async () => toggle.click()); assert(commands.includes("TogglePlayerState"));
    await act(async () => document.querySelector(".minimode-header-container").dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
    await update({ musicItem: null, playerState: constants.PlayerState.None });
    assert.equal(bar(), null);
    assert.equal(mini().dataset.playing, "false");
    assert.equal(mini().dataset.spinning, "false");
    // Keep the actual mounted UI available for main-process screenshots and reduced-motion checks.
    window.vinylPreviewMode = async mode => {
        await update({ musicItem: songA, playerState: mode === "paused" ? constants.PlayerState.Paused : constants.PlayerState.Playing });
        await act(async () => detailStore.musicDetailShownStore.setValue(mode !== "bar-mini"));
        await wait(550); await frame();
        document.querySelector(mode === "bar-mini" ? ".test-bar" : ".test-detail").scrollIntoView({ block: "start" });
        await wait(180);
    };
    window.vinylFinish = async () => {
        await act(async () => view.unmount());
        assert.equal(subscribers.size, 0, "Mini subscriptions leaked after unmount");
        delete document.visibilityState;
        delete window["@shared/message-bus/extension"];
        style.remove();
    };
    return "PASS: real React/SCSS + Chromium record rotation, angle-preserving pause/resume, transparent material decode, actual sprite alpha-boundary fit, visible needle groove/rest geometry, static reflections, independent arm movement, 44px/56px fit, main Store and mini bus sync, hidden-window suspension, track switch, broken-cover fallback, keyboard/double-click/hover controls, cleanup; reduced-motion verified by main runner";
};
