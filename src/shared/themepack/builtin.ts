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
export function setupBuiltinTheme(initialTheme: BuiltinTheme = "jiangnan") {
    if (!initialized) {
        AppConfig.onConfigUpdate((patch, config) => {
            if ("normal.builtinTheme" in patch) {
                applyBuiltinTheme(config["normal.builtinTheme"]);
            }
        });
        initialized = true;
        // Blue is the default even for a legacy classic selection. A restored
        // external pack opts out explicitly after its stylesheet is available.
        applyBuiltinTheme(initialTheme);
    }
}

export function selectBuiltinTheme(theme: BuiltinTheme) {
    applyBuiltinTheme(theme);
    if (AppConfig.getConfig("normal.builtinTheme") !== theme) {
        AppConfig.setConfig({ "normal.builtinTheme": theme });
    }
}
