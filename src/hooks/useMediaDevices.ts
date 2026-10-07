import { useEffect, useState } from "react";

export function useOutputAudioDevices() {
    const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
    useEffect(() => {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        let active = true, generation = 0;
        const refresh = async () => {
            const request = ++generation;
            try {
                const next = await navigator.mediaDevices.enumerateDevices();
                if (active && request === generation) setDevices(next.filter(device => device.kind === "audiooutput"));
            } catch (error) {
                console.error("Audio device list refresh failed", error);
            }
        };
        navigator.mediaDevices.addEventListener("devicechange", refresh);
        void refresh();
        return () => {
            active = false;
            navigator.mediaDevices.removeEventListener("devicechange", refresh);
        };
    }, []);
    return devices;
}
