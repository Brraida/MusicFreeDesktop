import type { App } from "electron";
import { spawn } from "child_process";
import path from "path";
import { setTimeout, clearTimeout } from "timers";

/** Squirrel hooks must finish before loading the player or claiming its instance lock. */
export function handleSquirrelEvent(app: Pick<App, "isPackaged" | "exit">): boolean {
    if (process.platform !== "win32" || !app.isPackaged) return false;
    const event = process.argv[1];
    if (event === "--squirrel-obsolete") {
        app.exit(0);
        return true;
    }
    const operation = event === "--squirrel-install" || event === "--squirrel-updated"
        ? "--createShortcut" : event === "--squirrel-uninstall" ? "--removeShortcut" : undefined;
    if (!operation) return false;

    const updater = path.resolve(path.dirname(process.execPath), "..", "Update.exe");
    let finished = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (code: number, error?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (error) console.error("Squirrel shortcut operation failed", event, error);
        app.exit(code);
    };
    try {
        const child = spawn(updater, [operation, path.basename(process.execPath), "--shortcut-locations=Desktop,StartMenu"], {
            windowsHide: true, stdio: "ignore",
        });
        // Squirrel waits about 15 seconds for a hook; leave time to report failure.
        timeout = setTimeout(() => {
            try {
                child.kill();
            } catch (error) {
                finish(1, error);
                return;
            }
            finish(1, new Error("Shortcut operation timed out"));
        }, 10000);
        child.once("error", error => finish(1, error));
        child.once("close", (code, signal) => finish(code === 0 ? 0 : 1,
            code === 0 ? undefined : new Error(`Updater exited with ${code ?? signal}`)));
    } catch (error) {
        finish(1, error);
    }
    return true;
}
