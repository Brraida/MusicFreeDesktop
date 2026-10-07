const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

// Sharp 0.32 copies Windows DLLs beside its addon at install time. Keep those
// runtime copies and vendor metadata; remove only byte-identical vendor DLLs.
async function trimSharpDlls(buildPath, platform, arch) {
    if (platform !== "win32") return { files: 0, bytes: 0 };
    const sharp = path.join(buildPath, "node_modules/sharp");
    const vendor = path.join(sharp, "vendor");
    const result = { files: 0, bytes: 0 };
    for (const version of await fs.readdir(vendor, { withFileTypes: true })) {
        if (!version.isDirectory()) continue;
        const library = path.join(vendor, version.name, `win32-${arch}/lib`);
        const entries = await fs.readdir(library).catch(error => {
            if (error.code === "ENOENT") return [];
            throw error;
        });
        for (const name of entries.filter(name => name.endsWith(".dll"))) {
            const original = path.join(library, name);
            const runtime = path.join(sharp, "build/Release", name);
            const [left, right] = await Promise.all([fs.readFile(original), fs.readFile(runtime).catch(error => {
                if (error.code === "ENOENT") return null;
                throw error;
            })]);
            if (!right || left.length !== right.length) continue;
            const digest = bytes => createHash("sha256").update(bytes).digest("hex");
            if (digest(left) !== digest(right)) continue;
            await fs.unlink(original);
            result.files++;
            result.bytes += left.length;
        }
    }
    return result;
}
module.exports = { trimSharpDlls };
