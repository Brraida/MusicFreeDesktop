import fs from "fs";

export function parseConfigJSON(raw: string): Record<string, any> {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => ["__proto__", "constructor", "prototype"].includes(key))) {
        throw new Error("Configuration must be an object");
    }
    return value;
}

/** Replace in the same directory; the current file is never truncated in place. */
function replaceFile(file: string, raw: string) {
    const temporary = file + ".tmp";
    let fd: number;
    try {
        fd = fs.openSync(temporary, "w", 0o600);
        fs.writeFileSync(fd, raw, "utf8");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporary, file);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try {
            fs.unlinkSync(temporary);
        } catch (error) {
            if (error.code !== "ENOENT") console.error("Configuration temporary file cleanup failed", error);
        }
    }
}

export function saveConfigJSON(file: string, raw: string, previous?: string) {
    parseConfigJSON(raw);
    if (previous !== undefined) {
        parseConfigJSON(previous);
        replaceFile(file + ".bak", previous);
    }
    replaceFile(file, raw);
}
