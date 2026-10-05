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
}

export interface DownloadWatchEvent {
    paths: string[];
    full?: boolean;
    error?: string;
}

export function effectiveResourceState(status: DownloadResourceStatus) {
    return status.state === DownloadResourceState.CHECKING
        ? status.previousState ?? DownloadResourceState.NO_RECORD : status.state;
}
