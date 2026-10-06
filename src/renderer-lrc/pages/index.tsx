import "./index.scss";
import classNames from "@/renderer/utils/classnames";
import { CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import Condition from "@/renderer/components/Condition";
import SvgAsset from "@/renderer/components/SvgAsset";
import { PlayerState } from "@/common/constant";
import useLyricPair from "@/renderer/utils/use-lyric-pair";
import { LYRIC_LAYOUT, normalizeLyricFontSize } from "@/common/lyric-layout";
import { useTranslation } from "react-i18next";
import useAppConfig from "@/hooks/useAppConfig";
import { appWindowUtil } from "@shared/utils/renderer";
import AppConfig from "@shared/app-config/renderer";
import messageBus, { useAppStatePartial } from "@shared/message-bus/renderer/extension";


export default function LyricWindowPage() {
    const currentMusic = useAppStatePartial("musicItem");
    const playerState = useAppStatePartial("playerState");
    const lockLyric = useAppConfig("lyric.lockLyric");
    const [showOperations, setShowOperations] = useState(false);

    const mouseOverTimerRef = useRef<number | null>(null);

    useEffect(() => () => {
        if (mouseOverTimerRef.current) window.clearTimeout(mouseOverTimerRef.current);
    }, []);

    useEffect(() => {
        if (lockLyric) {
            setShowOperations(false);
        }
    }, [lockLyric]);

    return (
        <div
            className={classNames({
                "container": true,
                "lock-lyric": lockLyric,
            })}
            onMouseOver={() => {
                if (!lockLyric || mouseOverTimerRef.current) {
                    if (!lockLyric) {
                        setShowOperations(true);
                    }
                    return;
                }
                mouseOverTimerRef.current = window.setTimeout(() => {
                    setShowOperations(true);
                    clearTimeout(mouseOverTimerRef.current);
                    mouseOverTimerRef.current = null;
                }, 1000);
            }}
            onMouseLeave={() => {
                setShowOperations(false);
                if (mouseOverTimerRef.current) {
                    clearTimeout(mouseOverTimerRef.current);
                    mouseOverTimerRef.current = null;
                }
            }}
        >
            <div className='operation-outer-container'>
                <Condition condition={showOperations}>
                    <div className="operation-container">
                        <Condition
                            condition={!lockLyric}
                            falsy={
                                <div
                                    className="operation-button"
                                    onClick={() => {
                                        AppConfig.setConfig({
                                            "lyric.lockLyric": false,
                                        });
                                    }}
                                    onMouseOver={() => {
                                        appWindowUtil.ignoreMouseEvent(false);
                                    }}
                                    onMouseLeave={() => {
                                        appWindowUtil.ignoreMouseEvent(true);
                                    }}
                                >
                                    <SvgAsset iconName="lock-open"></SvgAsset>
                                </div>
                            }
                        >
                            <div
                                className="operation-button"
                                onClick={() => {
                                    messageBus.sendCommand("SkipToPrevious");
                                }}
                            >
                                <SvgAsset iconName="skip-left"></SvgAsset>
                            </div>
                            <div
                                className="operation-button"
                                onClick={() => {
                                    if (currentMusic) {
                                        messageBus.sendCommand("TogglePlayerState");
                                    }
                                }}
                            >
                                <SvgAsset
                                    iconName={
                                        playerState === PlayerState.Playing ? "pause" : "play"
                                    }
                                ></SvgAsset>
                            </div>
                            <div
                                className="operation-button"
                                onClick={() => {
                                    messageBus.sendCommand("SkipToNext");
                                }}
                            >
                                <SvgAsset iconName="skip-right"></SvgAsset>
                            </div>
                            <div
                                className="operation-button"
                                onClick={() => {
                                    AppConfig.setConfig({
                                        "lyric.lockLyric": true,
                                    });
                                }}
                            >
                                <SvgAsset iconName="lock-closed"></SvgAsset>
                            </div>
                            <div
                                className="operation-button"
                                onClick={() => {
                                    appWindowUtil.setLyricWindow(false);
                                }}
                            >
                                <SvgAsset iconName="x-mark"></SvgAsset>
                            </div>
                        </Condition>
                    </div>
                </Condition>
            </div>
            <div className="content-container">
                <LyricContent></LyricContent>
            </div>
        </div>
    );
}

function LyricContent() {
    const { pair, musicItem, progress, duration, offset, playerState } = useLyricPair();
    const fontData = useAppConfig("lyric.fontData");
    const fontSize = normalizeLyricFontSize(useAppConfig("lyric.fontSize") ?? LYRIC_LAYOUT.defaultFont);
    const color = useAppConfig("lyric.fontColor") || LYRIC_LAYOUT.color;
    const stroke = useAppConfig("lyric.strokeColor") || LYRIC_LAYOUT.stroke;
    const { t } = useTranslation();
    const songText = musicItem ? `${musicItem.title} - ${musicItem.artist}` : t("music_detail.no_lyric");
    const currentText = pair.current?.lrc || (pair.phase === "instrumental" ? t("lyric_pair.instrumental") : songText);
    const nextColor = color === LYRIC_LAYOUT.color ? LYRIC_LAYOUT.nextColor : color;
    const playing = playerState === PlayerState.Playing;
    const trackKey = musicItem ? `${musicItem.platform}:${musicItem.id}` : "empty";

    return (
        <div className="lyric-pair" data-phase={pair.phase} style={{
            fontFamily: fontData?.family || undefined,
            "--lyric-line-height": LYRIC_LAYOUT.lineHeight,
            "--lyric-gap": `${LYRIC_LAYOUT.gap}px`,
        } as CSSProperties}>
            <LyricRow
                key={`current:${trackKey}`}
                current
                text={currentText}
                label={t("lyric_pair.current")}
                fontSize={fontSize}
                color={color}
                stroke={stroke}
                playing={playing}
                position={progress - offset}
                start={pair.current?.time}
                end={pair.endTime ?? (duration > 0 ? duration - offset : undefined)}
            />
            <LyricRow
                key={`next:${trackKey}:${pair.next?.index}:${pair.next?.time}`}
                text={pair.next?.lrc || ""}
                label={t("lyric_pair.next")}
                fontSize={fontSize * LYRIC_LAYOUT.nextScale}
                color={nextColor}
                stroke={stroke}
                playing={playing}
            />
        </div>
    );
}

function LyricRow({ current = false, text, label, fontSize, color, stroke, playing, position, start, end }: {
    current?: boolean; text: string; label: string; fontSize: number; color: string; stroke: string;
    playing: boolean; position?: number; start?: number; end?: number;
}) {
    const clipRef = useRef<HTMLDivElement>(null);
    const textRef = useRef<HTMLSpanElement>(null);
    const [size, setSize] = useState({ clip: 0, text: 0 });
    useLayoutEffect(() => {
        const measure = () => {
            const clip = clipRef.current?.clientWidth ?? 0;
            const width = textRef.current?.scrollWidth ?? 0;
            setSize(previous => previous.clip === clip && previous.text === width
                ? previous : { clip, text: width });
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(clipRef.current);
        observer.observe(textRef.current);
        return () => observer.disconnect();
    }, [text, fontSize]);
    const overflow = Math.max(0, size.text - size.clip);
    let left = 0;
    if (current && overflow && start !== undefined && end > start) {
        const fraction = Math.max(0, Math.min(1, ((position ?? start) - start) / (end - start)));
        left = -Math.min(overflow, Math.max(0, fraction * size.text - size.clip * 0.5) * 1.1);
    }
    return (
        <div ref={clipRef} className={classNames({
            "lyric-text-row": true,
            "lyric-current-row": current, "lyric-next-row": !current,
            "lyric-overflow": overflow > 0, "lyric-empty": !text,
        })} data-playing={playing} aria-label={label} title={text}
        style={{ fontSize, color, WebkitTextStrokeColor: stroke }}>
            <span ref={textRef} className="lyric-row-text" style={{
                transform: current ? `translateX(${left}px)` : undefined,
                "--lyric-overflow": `${-overflow}px`,
                "--lyric-marquee-duration": `${Math.max(8, size.text / 24)}s`,
            } as CSSProperties}>{text || "\u00a0"}</span>
        </div>
    );
}
