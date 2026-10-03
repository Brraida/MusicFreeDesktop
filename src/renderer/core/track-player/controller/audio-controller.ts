/**
 * 播放音乐
 */
import { encodeUrlHeaders } from "@/common/normalize-util";
import albumImg from "@/assets/imgs/album-cover.jpg";
import getUrlExt from "@/renderer/utils/get-url-ext";
import Hls, { Events as HlsEvents, HlsConfig } from "hls.js";
import { PlayerState } from "@/common/constant";
import ServiceManager from "@shared/service-manager/renderer";
import ControllerBase from "@renderer/core/track-player/controller/controller-base";
import { ErrorReason } from "@renderer/core/track-player/enum";
import Dexie from "dexie";
import voidCallback from "@/common/void-callback";
import { IAudioController } from "@/types/audio-controller";
import Promise = Dexie.Promise;


class AudioController extends ControllerBase implements IAudioController {
    private audio: HTMLAudioElement;
    private hls: Hls;
    private sourceGeneration = 0;
    private sourceFetch: AbortController | null = null;
    private objectUrl: string | null = null;
    private wantsPlay = false;
    private pendingSeek: number | null = null;

    private _playerState: PlayerState = PlayerState.None;
    get playerState() {
        return this._playerState;
    }
    set playerState(value: PlayerState) {
        if (this._playerState !== value) {
            this.onPlayerStateChanged?.(value);
        }
        this._playerState = value;

    }

    public musicItem: IMusic.IMusicItem | null = null;

    get hasSource() {
        return !!this.audio.src;
    }

    constructor() {
        super();
        this.audio = new Audio();
        this.audio.preload = "auto";
        this.audio.controls = false;

        ////// events
        this.audio.onplaying = () => {
            this.playerState = PlayerState.Playing;
            navigator.mediaSession.playbackState = "playing";
        };

        this.audio.onpause = () => {
            this.playerState = PlayerState.Paused;
            navigator.mediaSession.playbackState = "paused";
        };

        this.audio.onerror = (event) => {
            if (!this.hasSource) return;
            this.playerState = PlayerState.Paused;
            navigator.mediaSession.playbackState = "paused";
            this.onError?.(ErrorReason.EmptyResource, event as any);
        };

        this.audio.ontimeupdate = () => {
            this.onProgressUpdate?.({
                currentTime: this.audio.currentTime,
                duration: this.audio.duration, // 缓冲中是Infinity
            });
        };

        // this.audio.onseeking = () => {
        //     this.playerState = PlayerState.Buffering;
        // }
        //
        // this.audio.onseeked = () => {
        //     this.playerState = PlayerState.Playing;
        // }

        this.audio.onended = () => {
            this.playerState = PlayerState.Paused;
            this.onEnded?.();
        };

        this.audio.onvolumechange = () => {
            this.onVolumeChange?.(this.audio.volume);
        };

        this.audio.onratechange = () => {
            this.onSpeedChange?.(this.audio.playbackRate);
        };

        this.audio.onloadedmetadata = () => {
            this.applyPendingSeek();
            if (this.wantsPlay) this.play();
        };


        // @ts-ignore  isDev
        window.ad = this.audio;
    }

    private initHls(config?: Partial<HlsConfig>) {
        if (!this.hls) {
            this.hls = new Hls(config);
            const hls = this.hls;
            const generation = this.sourceGeneration;
            hls.attachMedia(this.audio);
            hls.on(HlsEvents.ERROR, (evt, error) => {
                if (hls === this.hls && generation === this.sourceGeneration && error.fatal) {
                    this.onError?.(ErrorReason.EmptyResource, error);
                }
            });
        }
    }

    private destroyHls() {
        if (this.hls) {
            const hls = this.hls;
            this.hls = null;
            hls.detachMedia();
            hls.off(HlsEvents.ERROR);
            hls.destroy();
        }
    }

    destroy(): void {
        this.reset();
    }

    pause(): void {
        this.wantsPlay = false;
        if (this.hasSource) {
            this.audio.pause();
        }
    }

    play(): void {
        this.wantsPlay = true;
        if (this.hasSource) {
            this.audio.play().catch(voidCallback);
        }
    }

    reset(): void {
        this.releaseSource();
        this.musicItem = null;
        this.playerState = PlayerState.None;
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
    }

    seekTo(seconds: number): void {
        if (isFinite(seconds)) {
            this.pendingSeek = Math.max(0, seconds);
            this.applyPendingSeek();
        }
    }

    private applyPendingSeek() {
        if (!this.hasSource || this.pendingSeek === null) return;
        try {
            const duration = this.audio.duration;
            this.audio.currentTime = Math.min(this.pendingSeek, isNaN(duration) ? Infinity : duration);
            this.pendingSeek = null;
        } catch {
            // Retry once metadata is available (including HLS and Blob sources).
        }
    }

    private releaseSource() {
        ++this.sourceGeneration;
        this.sourceFetch?.abort();
        this.sourceFetch = null;
        this.wantsPlay = false;
        this.pendingSeek = null;
        this.destroyHls();
        this.audio.pause();
        this.audio.removeAttribute("src");
        this.audio.load();
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = null;
        }
    }

    setLoop(isLoop: boolean): void {
        this.audio.loop = isLoop;
    }

    setSinkId(deviceId: string): Promise<void> {
        return (this.audio as any).setSinkId(deviceId);
    }

    setSpeed(speed: number): void {
        this.audio.defaultPlaybackRate = speed;
        this.audio.playbackRate = speed;
    }

    prepareTrack(musicItem: IMusic.IMusicItem) {
        this.releaseSource();
        this.musicItem = { ...musicItem };

        // 1. update metadata
        navigator.mediaSession.metadata = new MediaMetadata({
            title: musicItem.title,
            artist: musicItem.artist,
            album: musicItem.album,
            artwork: [
                {
                    src: musicItem.artwork ?? albumImg,
                },
            ],
        });

        // 2. reset track
        this.playerState = PlayerState.None;
        navigator.mediaSession.playbackState = "none";
    }

    setTrackSource(trackSource: IMusic.IMusicSource, musicItem: IMusic.IMusicItem): void {
        this.releaseSource();
        const generation = this.sourceGeneration;
        this.musicItem = { ...musicItem };

        // 1. update metadata
        navigator.mediaSession.metadata = new MediaMetadata({
            title: musicItem.title,
            artist: musicItem.artist,
            album: musicItem.album,
            artwork: [
                {
                    src: musicItem.artwork ?? albumImg,
                },
            ],
        });


        // 2. convert url and headers
        let url = trackSource.url;
        const urlObj = new URL(trackSource.url);
        let headers: Record<string, any> | null = null;

        // 2.1 convert user agent
        if (trackSource.headers || trackSource.userAgent) {
            headers = { ...(trackSource.headers ?? {}) };
            if (trackSource.userAgent) {
                headers["user-agent"] = trackSource.userAgent;
            }
        }

        // 2.2 convert auth header
        if (urlObj.username && urlObj.password) {
            const authHeader = `Basic ${btoa(
                `${decodeURIComponent(urlObj.username)}:${decodeURIComponent(
                    urlObj.password,
                )}`,
            )}`;
            urlObj.username = "";
            urlObj.password = "";
            headers = {
                ...(headers || {}),
                Authorization: authHeader,
            };
            url = urlObj.toString();
        }

        // HLS must resolve relative segments against the original manifest URL.
        // Apply headers to every HLS request through the existing Electron hook.
        if (getUrlExt(url)?.toLowerCase() === ".m3u8") {
            if (!Hls.isSupported()) {
                this.onError?.(ErrorReason.UnsupportedResource);
                return;
            }
            this.initHls(headers ? {
                xhrSetup: (xhr, requestUrl) => {
                    xhr.open("GET", encodeUrlHeaders(requestUrl, headers), true);
                },
            } : undefined);
            this.hls.loadSource(url);
            return;
        }

        // 2.3 hack url with headers
        if (headers) {
            const forwardedUrl = ServiceManager.RequestForwarderService.forwardRequest(url, "GET", headers);
            if (forwardedUrl) {
                url = forwardedUrl;
                headers = null;
            } else if (!headers["Authorization"]) {
                url = encodeUrlHeaders(url, headers);
                headers = null;
            }
        }

        if (!url) {
            this.onError?.(ErrorReason.EmptyResource, new Error("url is empty"));
            return;
        }

        // 3. set real source
        if (headers) {
            const controller = new AbortController();
            this.sourceFetch = controller;
            fetch(url, {
                method: "GET",
                headers,
                signal: controller.signal,
            })
                .then(async (res) => {
                    if (!res.ok) {
                        await res.body?.cancel();
                        throw new Error(`HTTP ${res.status}`);
                    }
                    if (generation !== this.sourceGeneration || controller.signal.aborted) {
                        await res.body?.cancel();
                        return;
                    }
                    const blob = await res.blob();
                    if (generation === this.sourceGeneration && !controller.signal.aborted) {
                        this.objectUrl = URL.createObjectURL(blob);
                        this.audio.src = this.objectUrl;
                        this.applyPendingSeek();
                        if (this.wantsPlay) this.play();
                    }
                }).catch(error => {
                    if (generation === this.sourceGeneration && !controller.signal.aborted) {
                        this.wantsPlay = false;
                        this.playerState = PlayerState.Paused;
                        this.onError?.(ErrorReason.EmptyResource, error);
                    }
                }).finally(() => {
                    if (this.sourceFetch === controller) this.sourceFetch = null;
                });
        } else {
            this.audio.src = url;
        }
    }

    setVolume(volume: number): void {
        this.audio.volume = volume;
    }
}

export default AudioController;
