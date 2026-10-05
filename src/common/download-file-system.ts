import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { DownloadResourceState, DownloadFileIdentity, DownloadFileInspection } from "./download-resource";

function inaccessible(error: NodeJS.ErrnoException): DownloadFileInspection {
    return { state: DownloadResourceState.UNAVAILABLE,
        reason: error.code === "EACCES" || error.code === "EPERM" ? "permission" : "io" };
}

async function classifyMissing(filePath: string, identity?: DownloadFileIdentity): Promise<DownloadFileInspection> {
    const root = path.parse(path.resolve(filePath)).root;
    try {
        await fs.stat(root);
    } catch (error) {
        return { state: DownloadResourceState.UNAVAILABLE, reason: "offline" };
    }
    // On Unix an unmounted volume can leave an accessible mount point behind.
    let ancestor = path.dirname(filePath);
    while (true) {
        try {
            const stat = await fs.stat(ancestor);
            return identity?.device && identity.device !== String(stat.dev)
                ? { state: DownloadResourceState.UNAVAILABLE, reason: "offline" }
                : { state: DownloadResourceState.MISSING, reason: "missing" };
        } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return inaccessible(error);
            const parent = path.dirname(ancestor);
            if (parent === ancestor) return { state: DownloadResourceState.UNAVAILABLE, reason: "offline" };
            ancestor = parent;
        }
    }
}

/** Read permission, stable size and (when needed) SHA-256 are checked together. */
export async function inspectDownloadFile(
    filePath: string, expected?: DownloadFileIdentity, forceHash = false,
): Promise<DownloadFileInspection> {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
        handle = await fs.open(filePath, "r");
        const before = await handle.stat();
        if (!before.isFile()) return { state: DownloadResourceState.UNAVAILABLE, reason: "not-file" };
        if (!before.size) return { state: DownloadResourceState.UNAVAILABLE, reason: "empty" };
        if (expected && before.size !== expected.size) return { state: DownloadResourceState.UNAVAILABLE, reason: "changed" };
        let sha256 = expected?.sha256;
        if (forceHash || !sha256 || before.mtimeMs !== expected.mtimeMs) {
            const hash = createHash("sha256");
            for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
            sha256 = hash.digest("hex");
            if (expected && sha256 !== expected.sha256) return { state: DownloadResourceState.UNAVAILABLE, reason: "changed" };
        } else {
            // Opening a file is insufficient on filesystems that defer read errors.
            await handle.read(Buffer.alloc(1), 0, 1, 0);
        }
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
            return { state: DownloadResourceState.UNAVAILABLE, reason: "changed" };
        }
        return { state: DownloadResourceState.AVAILABLE,
            identity: { size: after.size, sha256, mtimeMs: after.mtimeMs, device: String(after.dev) } };
    } catch (error) {
        return error.code === "ENOENT" || error.code === "ENOTDIR"
            ? classifyMissing(filePath, expected) : inaccessible(error);
    } finally {
        await handle?.close().catch(() => undefined);
    }
}
