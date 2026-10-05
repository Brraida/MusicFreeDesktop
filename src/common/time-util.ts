/** Plugin data may contain seconds as text or an already formatted duration. */
export function durationToSeconds(value: unknown): number | undefined {
    let seconds: number;
    if (typeof value === "number") {
        seconds = value;
    } else if (typeof value === "string" && value.trim()) {
        const text = value.trim();
        if (/^\d+(?:\.\d+)?$/.test(text)) {
            seconds = Number(text);
        } else if (/^(?:\d+:)?\d{1,2}:\d{2}$/.test(text)) {
            const parts = text.split(":").map(Number);
            if (parts.slice(1).some(part => part >= 60)) return undefined;
            seconds = parts.reduce((total, part) => total * 60 + part, 0);
        }
    }
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export function secondsToDuration(seconds: number | string) {
    const value = durationToSeconds(seconds);
    if (value === undefined) return "--:--";
    const total = Math.floor(value);
    const sec = String(total % 60).padStart(2, "0");
    const min = String(Math.floor(total / 60) % 60).padStart(2, "0");
    const hour = Math.floor(total / 3600);
    return hour ? `${hour}:${min}:${sec}` : `${min}:${sec}`;
}

export function delay(millsecond: number) {
    return new Promise<void>((resolve) => {
        setTimeout(() => {
            resolve();
        }, millsecond);
    });
}
