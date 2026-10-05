import { HTMLAttributes, useEffect, useState } from "react";
import albumImg from "@/assets/imgs/album-cover.jpg";
import tonearmTexture from "@/assets/imgs/vinyl-tonearm-real-v1.png";
import recordTexture from "@/assets/imgs/vinyl-record-real-v1.png";
import "./index.scss";

interface VinylCoverProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
    artwork?: string;
    alt: string;
    playing: boolean;
    active?: boolean;
    trackKey?: string;
    compact?: boolean;
}

// Measured in the original transparent sprite. The transform maps its pivot to
// (82, 16) and its needle to (64, 78) in the 100 × 100 cover coordinate system.
export const tonearmGeometry = {
    width: 1024,
    height: 1536,
    pivot: { x: 654, y: 317 },
    needle: { x: 198, y: 1480 },
    transform: "matrix(0.051466673 -0.004702324 0.004702324 0.051466673 46.850159 2.760385)",
};

/** The record rotates independently of the arm; pausing preserves its current angle. */
export default function VinylCover({ artwork, alt, playing, active = true, trackKey, compact = false, className = "", ...props }: VinylCoverProps) {
    const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");

    useEffect(() => {
        const updateVisibility = () => setVisible(document.visibilityState !== "hidden");
        document.addEventListener("visibilitychange", updateVisibility);
        return () => document.removeEventListener("visibilitychange", updateVisibility);
    }, []);

    return <div {...props} className={`vinyl-cover ${className}`} data-compact={compact} data-playing={playing} data-spinning={playing && active && visible}>
        <span className="vinyl-sheen" style={{ backgroundImage: `url("${recordTexture}")` }} aria-hidden="true" />
        <div key={trackKey} className="vinyl-record">
            <img
                key={artwork || albumImg}
                className="vinyl-artwork"
                src={artwork || albumImg}
                alt={alt}
                draggable={false}
                onError={({ currentTarget }) => {
                    if (currentTarget.dataset.fallback === "true") return;
                    currentTarget.dataset.fallback = "true";
                    currentTarget.src = albumImg;
                }}
            />
        </div>
        <span className="vinyl-spindle" aria-hidden="true" />
        <svg className="vinyl-arm" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
            <g className="vinyl-arm-moving">
                <image
                    className="vinyl-arm-texture"
                    href={tonearmTexture}
                    width={tonearmGeometry.width}
                    height={tonearmGeometry.height}
                    transform={tonearmGeometry.transform}
                />
            </g>
        </svg>
    </div>;
}
