import AppConfig from "@shared/app-config/renderer";
import "./jiangnan.scss";

export type BuiltinTheme = "classic" | "jiangnan";

function applyBuiltinTheme(theme: BuiltinTheme) {
    if (theme === "jiangnan") {
        document.documentElement.dataset.builtinTheme = "jiangnan";
    } else {
        delete document.documentElement.dataset.builtinTheme;
    }
}

let initialized = false;

/** Bind once per renderer; config broadcasts also update an open mini player. */
export function setupBuiltinTheme() {
    if (!initialized) {
        AppConfig.onConfigUpdate((patch, config) => {
            if ("normal.builtinTheme" in patch) {
                applyBuiltinTheme(config["normal.builtinTheme"]);
            }
        });
        initialized = true;
    }
    applyBuiltinTheme(AppConfig.getConfig("normal.builtinTheme"));
}

export function selectBuiltinTheme(theme: BuiltinTheme) {
    applyBuiltinTheme(theme);
    AppConfig.setConfig({ "normal.builtinTheme": theme });
}
