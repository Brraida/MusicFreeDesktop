import config from "./eslint.config.mjs";

// Share the existing style rules without enabling unrelated code-quality checks.
export default config.map((entry) => {
    if (!entry.rules) return entry;
    const rules = {};
    for (const [name, rule] of Object.entries(entry.rules)) {
        const [severity, ...options] = Array.isArray(rule) ? rule : [rule];
        rules[name] = name.startsWith("@stylistic/") && severity !== "off" && severity !== 0
            ? ["error", ...options]
            : "off";
    }
    return {
        ...entry,
        linterOptions: {
            ...entry.linterOptions,
            reportUnusedDisableDirectives: false,
        },
        rules,
    };
});
