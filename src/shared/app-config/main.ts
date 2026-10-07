import path from "path";
import { app, ipcMain } from "electron";
import fs from "fs/promises";
import { parseConfigJSON, saveConfigJSON } from "@/common/atomic-json";
import { IAppConfig } from "@/types/app-config";
import { IWindowManager } from "@/types/main/window-manager";
import logger from "@shared/logger/main";
import _defaultAppConfig from "@shared/app-config/default-app-config";


class AppConfig {
    private _configPath: string;
    private windowManager: IWindowManager;
    private config: IAppConfig;
    private persistedRaw?: string;
    private lastSaveError?: string;

    private onAppConfigUpdatedCallbacks = new Set<(patch: IAppConfig, config: IAppConfig, from: "main" | "renderer") => void>();

    get configPath() {
        if (!this._configPath) {
            this._configPath = path.resolve(app.getPath("userData"), "config.json");
        }
        return this._configPath;
    }


    async setup(windowManager: IWindowManager) {
        this.windowManager = windowManager;

        await fs.mkdir(app.getPath("userData"), { recursive: true });
        await this.loadConfig();

        // Bind events
        // sync config
        ipcMain.handle("@shared/app-config/sync-app-config", () => {
            return this.config;
        });

        ipcMain.handle("@shared/app-config/set-app-config", (_rawEvt, data: IAppConfig) => {
            const success = this._setConfig(data, "renderer");
            return { success, config: this.config, error: success ? undefined : this.lastSaveError };
        });
        ipcMain.handle("@shared/app-config/reset", () => {
            const success = this.reset();
            return { success, config: this.config, error: success ? undefined : this.lastSaveError };
        });
    }

    public onConfigUpdated(callback: (patch: IAppConfig, config: IAppConfig, from: "main" | "renderer") => void) {
        this.onAppConfigUpdatedCallbacks.add(callback);
    }

    public offConfigUpdated(callback: (patch: IAppConfig, config: IAppConfig, from: "main" | "renderer") => void) {
        this.onAppConfigUpdatedCallbacks.delete(callback);
    }

    async migrateOldVersionConfig() {
        if (this.config["$schema-version"] >= 0) {
            return;
        }
        // 1. 升级到v1
        try {
            const oldConfig = this.config as any;
            const newConfig: any = {
                "normal.closeBehavior": oldConfig.normal?.closeBehavior === "exit" ? "exit_app" : oldConfig.normal?.closeBehavior,
                "normal.maxHistoryLength": oldConfig.normal?.maxHistoryLength,
                "normal.checkUpdate": oldConfig.normal?.checkUpdate,
                "normal.taskbarThumb": oldConfig.normal?.taskbarThumb,
                "normal.musicListColumnsShown": oldConfig.normal?.musicListColumnsShown,
                "normal.language": oldConfig.normal?.language,

                "playMusic.caseSensitiveInSearch": oldConfig.playMusic?.caseSensitiveInSearch,
                "playMusic.defaultQuality": oldConfig.playMusic?.defaultQuality,
                "playMusic.whenQualityMissing": oldConfig.playMusic?.whenQualityMissing,
                "playMusic.clickMusicList": oldConfig.playMusic?.clickMusicList,
                "playMusic.playError": oldConfig.playMusic?.playError,
                "playMusic.audioOutputDevice": oldConfig.playMusic?.audioOutputDevice,
                "playMusic.whenDeviceRemoved": oldConfig.playMusic?.whenDeviceRemoved,

                "lyric.enableStatusBarLyric": oldConfig.lyric?.enableStatusBarLyric,
                "lyric.enableDesktopLyric": oldConfig.lyric?.enableDesktopLyric,
                "lyric.alwaysOnTop": oldConfig.lyric?.alwaysOnTop,
                "lyric.lockLyric": oldConfig.lyric?.lockLyric,
                "lyric.fontData": oldConfig.lyric?.fontData,
                "lyric.fontColor": oldConfig.lyric?.fontColor,
                "lyric.fontSize": oldConfig.lyric?.fontSize,
                "lyric.strokeColor": oldConfig.lyric?.strokeColor,

                "shortCut.enableLocal": oldConfig.shortCut?.enableLocal,
                "shortCut.enableGlobal": oldConfig.shortCut?.enableGlobal,
                "shortCut.shortcuts": {
                    ...oldConfig.shortCut?.shortcuts,
                    "toggle-main-window-visible": { local: null, global: null },
                },

                "download.path": oldConfig.download?.path,
                "download.defaultQuality": oldConfig.download?.defaultQuality,
                "download.whenQualityMissing": oldConfig.download?.whenQualityMissing,
                "download.concurrency": oldConfig.download?.concurrency,

                "plugin.autoUpdatePlugin": oldConfig.plugin?.autoUpdatePlugin,
                "plugin.notCheckPluginVersion": oldConfig.plugin?.notCheckPluginVersion,

                "network.proxy.enabled": oldConfig.network?.proxy?.enabled,
                "network.proxy.host": oldConfig.network?.proxy?.host,
                "network.proxy.port": oldConfig.network?.proxy?.port,
                "network.proxy.username": oldConfig.network?.proxy?.username,
                "network.proxy.password": oldConfig.network?.proxy?.password,

                "backup.resumeBehavior": oldConfig.backup?.resumeBehavior,
                "backup.webdav.url": oldConfig.backup?.webdav?.url,
                "backup.webdav.username": oldConfig.backup?.webdav?.username,
                "backup.webdav.password": oldConfig.backup?.webdav?.password,

                "localMusic.watchDir": oldConfig.localMusic?.watchDir,

                "private.lyricWindowPosition": oldConfig.private?.lyricWindowPosition,
                "private.minimodeWindowPosition": oldConfig.private?.minimodeWindowPosition,
                "private.pluginMeta": oldConfig.private?.pluginMeta,
                "private.minimode": oldConfig.private?.minimode,
            };
            for (const k in _defaultAppConfig) {
                if (newConfig[k] === null || newConfig[k] === undefined) {
                    // @ts-ignore
                    newConfig[k] = _defaultAppConfig[k];
                }
            }
            const rawConfig = JSON.stringify(newConfig, undefined, 4);
            try {
                saveConfigJSON(this.configPath, rawConfig, this.persistedRaw);
                this.persistedRaw = rawConfig;
            } catch (error) {
                // This is a read-time representation change. Keep the legacy
                // settings usable; the disk still owns the old valid JSON.
                logger.logError("旧配置已读取，但保存迁移结果失败", error);
            }
            this.config = newConfig;
        } catch (e) {
            logger.logError("迁移旧版配置失败", e);
        }
    }

    async loadConfig() {
        if (this.config) return this.config;
        for (const file of [this.configPath, this.configPath + ".bak"]) {
            try {
                const raw = await fs.readFile(file, "utf8");
                this.config = parseConfigJSON(raw);
                this.persistedRaw = raw;
                if (file !== this.configPath) {
                    // A stale .tmp is never promoted; only a validated last committed backup.
                    try {
                        saveConfigJSON(this.configPath, raw);
                    } catch (error) {
                        this.persistedRaw = undefined;
                        logger.logError("配置备份已读取，但修复主文件失败", error);
                    }
                    logger.logInfo("Recovered configuration from the previous valid backup");
                }
                await this.migrateOldVersionConfig();
                this.config = { ..._defaultAppConfig, ...this.config };
                return this.config;
            } catch (error) {
                this.config = undefined;
                this.persistedRaw = undefined;
                if (error.code !== "ENOENT") logger.logError("读取配置失败", error);
            }
        }
        this.config = { ..._defaultAppConfig };
        const raw = JSON.stringify(this.config, undefined, 4);
        try {
            saveConfigJSON(this.configPath, raw);
            this.persistedRaw = raw;
        } catch (error) {
            logger.logError("写入默认配置失败", error);
        }
        return this.config;
    }

    public getAllConfig() {
        return this.config;
    }

    public reset() {
        return this._setConfig({ ..._defaultAppConfig }, "main", true);
    }

    public getConfig<T extends keyof IAppConfig>(key: T): IAppConfig[T] {
        return this.config[key];
    }

    public setConfig(data: IAppConfig) {
        return this._setConfig(data, "main");
    }

    private _setConfig(data: IAppConfig, from: "main" | "renderer", replace = false): boolean {
        let next: IAppConfig;
        try {
            if (!data || typeof data !== "object" || Array.isArray(data) ||
                Object.keys(data).some(key => ["__proto__", "constructor", "prototype"].includes(key))) {
                throw new Error("Invalid configuration patch");
            }
            next = { ..._defaultAppConfig, ...(replace ? {} : this.config), ...data };
            const raw = JSON.stringify(next, undefined, 4);
            if (raw !== this.persistedRaw) {
                saveConfigJSON(this.configPath, raw, this.persistedRaw);
                this.persistedRaw = raw;
            }
        } catch (error) {
            this.lastSaveError = [error.code, error.message].filter(Boolean).join(": ");
            logger.logError("设置配置失败", error);
            return false;
        }
        const patch = replace ? { ...Object.fromEntries(Object.keys(this.config ?? {}).map(key => [key, undefined])), ...next } : data;
        this.config = next;
        // Committed data remains successful even if one subscriber/window fails.
        for (const window of this.windowManager.getAllWindows()) {
            try {
                if (!window.isDestroyed()) window.webContents.send("@shared/app-config/update-app-config", patch);
            } catch (error) {
                logger.logError("配置窗口通知失败", error);
            }
        }
        for (const callback of this.onAppConfigUpdatedCallbacks) {
            try {
                callback(patch, this.config, from);
            } catch (error) {
                logger.logError("配置订阅通知失败", error);
            }
        }
        return true;
    }

}

export default new AppConfig();
