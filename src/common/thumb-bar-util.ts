/**
 * Thumb Bar Util
 */

import { BrowserWindow, nativeImage } from "electron";
import getResourcePath from "@/common/get-resource-path";
import { t } from "@shared/i18n/main";
import { ResourceName } from "@/common/constant";
import asyncMemoize from "@/common/async-memoize";
import fs from "fs/promises";
import logger from "@shared/logger/main";
import axios from "axios";
import messageBus from "@shared/message-bus/main";

/**
 * 设置缩略图按钮
 * @param window 当前窗口
 * @param isPlaying 当前是否正在播放音乐
 */
function setThumbBarButtons(window: BrowserWindow, isPlaying?: boolean) {
    if (!window || window.isDestroyed()) {
        return;
    }

    window.setThumbarButtons([
        {
            icon: nativeImage.createFromPath(getResourcePath(ResourceName.SKIP_LEFT_ICON)),
            tooltip: t("main.previous_music"),
            click() {
                messageBus.sendCommand("SkipToPrevious");
            },
        },
        {
            icon: nativeImage.createFromPath(
                getResourcePath(isPlaying ? ResourceName.PAUSE_ICON : ResourceName.PLAY_ICON),
            ),
            tooltip: isPlaying
                ? t("media.music_state_pause")
                : t("media.music_state_play"),
            click() {
                messageBus.sendCommand(
                    "TogglePlayerState",
                );
            },
        },
        {
            icon: nativeImage.createFromPath(getResourcePath(ResourceName.SKIP_RIGHT_ICON)),
            tooltip: t("main.next_music"),
            click() {
                messageBus.sendCommand("SkipToNext");
            },
        },
    ]);

}


// 获取默认的图片
const getDefaultAlbumCoverImage = asyncMemoize(async () => {
    return await fs.readFile((getResourcePath(ResourceName.DEFAULT_ALBUM_COVER_IMAGE)));
});

const hookedWindows = new WeakSet<BrowserWindow>();
const imageRequests = new WeakMap<BrowserWindow, AbortController>();

/**
 * 设置缩略图
 * @param window 窗口
 * @param src 图片url
 */
async function setThumbImage(window: BrowserWindow, src: string) {
    if (!window || window.isDestroyed()) {
        return;
    }

    // only support windows
    if (process.platform !== "win32") {
        return;
    }

    imageRequests.get(window)?.abort();
    const request = new AbortController();
    imageRequests.set(window, request);
    const current = () => !request.signal.aborted && !window.isDestroyed() && imageRequests.get(window) === request;
    try {
        const hwnd = window.getNativeWindowHandle().readBigUInt64LE(0);

        const taskBarThumbManager = (await import("@native/TaskbarThumbnailManager/TaskbarThumbnailManager.node")).default;

        if (!current()) return;
        if (!hookedWindows.has(window)) {
            taskBarThumbManager.config(hwnd);
            hookedWindows.add(window);
            window.once("closed", () => imageRequests.get(window)?.abort());
        }

        let buffer: Buffer;
        if (!src) {
            buffer = await getDefaultAlbumCoverImage();
        } else if (src.startsWith("http")) {
            try {
                buffer = (
                    await axios.get(src, {
                        responseType: "arraybuffer",
                        signal: request.signal,
                        timeout: 10000,
                    })
                ).data;
            } catch {
                buffer = await getDefaultAlbumCoverImage();
            }
        } else if (src.startsWith("data:image")) {
            buffer = Buffer.from(src.split(";base64,").pop(), "base64");
        } else {
            buffer = await getDefaultAlbumCoverImage();
        }

        if (!current()) return;
        const size = 106;

        const sharp = (await import("sharp")).default;
        const convert = (image: Buffer) => sharp(image)
            .resize(size, size, {
                fit: "cover",
            })
            .png()
            .ensureAlpha(1)
            .raw()
            .toBuffer({
                resolveWithObject: true,
            });

        let result;
        try {
            result = await convert(buffer);
        } catch (error) {
            if (!current()) return;
            logger.logError("Invalid taskbar cover; using default image", error);
            result = await convert(await getDefaultAlbumCoverImage());
        }

        if (!current()) return;
        taskBarThumbManager.sendIconicRepresentation(
            hwnd,
            {
                width: size,
                height: size,
            },
            result.data,
        );
    } catch (ex) {
        if (current()) logger.logError("Fail to setThumbImage", ex);
    }


}


const ThumbBarManager = {
    setThumbBarButtons,
    setThumbImage,
};

export default ThumbBarManager;
