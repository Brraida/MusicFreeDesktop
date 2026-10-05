/* global __webpack_public_path__: writable */
// Forge emits window entries one directory below shared chunks and assets.
const entryScript = document.currentScript;
if (entryScript?.src) {
    __webpack_public_path__ = new URL("../", entryScript.src).href;
}

performance.mark("player-launcher-ready");
const shell = document.getElementById("startup-shell");
const status = document.getElementById("startup-status");

shell?.addEventListener("click", event => {
    const action = event.target.closest("[data-window-action]")?.dataset.windowAction;
    const utils = window["@shared/utils"];
    if (action === "close") utils?.app.exitApp();
    if (action === "minimize") utils?.appWindow.minMainWindow();
    if (action === "retry") window.location.reload();
});

// Allow the static shell to paint before parsing and evaluating the player.
requestAnimationFrame(() => requestAnimationFrame(() => {
    performance.mark("player-shell-painted");
    import(/* webpackChunkName: "player" */ "./index").catch(error => {
        console.error("Player bundle failed to load", error);
        shell?.setAttribute("data-failed", "true");
        status?.setAttribute("role", "alert");
        if (status) status.textContent = "播放器加载失败，请重新加载。";
        const retry = document.getElementById("startup-retry");
        if (retry) retry.hidden = false;
    });
}));
