/** File availability is independent of a download task's progress. */
export enum DownloadResourceState {
    NO_RECORD = "NO_RECORD",
    CHECKING = "CHECKING",
    AVAILABLE = "AVAILABLE",
    MISSING = "MISSING",
    UNAVAILABLE = "UNAVAILABLE",
}

export interface DownloadFileIdentity {
    size: number;
    sha256: string;
    mtimeMs: number;
    device?: string;
}

export type DownloadFileReason = "missing" | "offline" | "permission" | "io" | "changed" | "empty" | "not-file" | "playback";

export interface DownloadFileInspection {
    state: DownloadResourceState.AVAILABLE | DownloadResourceState.MISSING | DownloadResourceState.UNAVAILABLE;
    identity?: DownloadFileIdentity;
    reason?: DownloadFileReason;
}

export interface DownloadResourceStatus {
    state: DownloadResourceState;
    previousState?: DownloadResourceState;
    path?: string;
    reason?: DownloadFileReason;
    /** Restored from a previous check; actions must still validate the target file. */
    cached?: boolean;
    checkedAt?: number;
}

export interface DownloadResourceSnapshot {
    version: 1;
    path: string;
    directory: string;
    state: DownloadFileInspection["state"];
    reason?: DownloadFileReason;
    checkedAt: number;
}

/** Restore only a result belonging to the same association and download configuration. */
export function restoreDownloadResource(
    data: { path: string; fingerprint?: DownloadFileIdentity; verified?: DownloadResourceSnapshot },
    directory: string, normalizePath: (path: string) => string,
): DownloadResourceStatus {
    const snapshot = data.verified;
    if (typeof data.path === "string" && snapshot?.version === 1 && typeof snapshot.path === "string" && typeof snapshot.directory === "string"
        && Number.isFinite(snapshot.checkedAt) && snapshot.checkedAt > 0
        && [DownloadResourceState.AVAILABLE, DownloadResourceState.MISSING, DownloadResourceState.UNAVAILABLE].includes(snapshot.state)
        && normalizePath(snapshot.path) === normalizePath(data.path)
        && normalizePath(snapshot.directory) === normalizePath(directory)
        && (snapshot.state !== DownloadResourceState.AVAILABLE || (data.fingerprint?.size > 0 && /^[a-f0-9]{64}$/.test(data.fingerprint.sha256)))) {
        return { state: snapshot.state, reason: snapshot.reason, path: data.path, checkedAt: snapshot.checkedAt, cached: true };
    }
    return { state: DownloadResourceState.CHECKING };
}

export interface DownloadWatchEvent {
    paths: string[];
    full?: boolean;
    error?: string;
}

export function effectiveResourceState(status?: DownloadResourceStatus) {
    if (!status) return DownloadResourceState.NO_RECORD;
    return status.state === DownloadResourceState.CHECKING
        ? status.previousState ?? DownloadResourceState.NO_RECORD : status.state;
}
