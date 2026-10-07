import "./index.scss";
import RadioGroupSettingItem from "../../components/RadioGroupSettingItem";
import CheckBoxSettingItem from "../../components/CheckBoxSettingItem";
import { useOutputAudioDevices } from "@/hooks/useMediaDevices";
import ListBoxSettingItem from "../../components/ListBoxSettingItem";
import trackPlayer from "@renderer/core/track-player";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import AppConfig from "@shared/app-config/renderer";
import { useRef } from "react";


export default function PlayMusic() {
    const audioDevices = useOutputAudioDevices();
    const { t } = useTranslation();
    const deviceChanges = useRef(Promise.resolve());
    const latestDeviceChange = useRef(0);

    return (
        <div className="setting-view--play-music-container">
            <CheckBoxSettingItem
                keyPath="playMusic.caseSensitiveInSearch"
                label={t("settings.play_music.case_sensitive_in_search")}
            ></CheckBoxSettingItem>
            <RadioGroupSettingItem
                label={t("settings.play_music.default_play_quality")}
                keyPath="playMusic.defaultQuality"
                options={[
                    "low",
                    "standard",
                    "high",
                    "super",
                ]}
                renderItem={it => t("media.music_quality_" + it)}

            ></RadioGroupSettingItem>
            <RadioGroupSettingItem
                label={t("settings.play_music.when_quality_missing")}
                keyPath="playMusic.whenQualityMissing"
                options={["lower", "higher", "skip"]}
                renderItem={it => t("settings.play_music.play_" + it + "_quality_version")}
            ></RadioGroupSettingItem>
            <RadioGroupSettingItem
                label={t("settings.play_music.when_play_error")}
                keyPath="playMusic.playError"
                options={["pause", "skip"]}
                renderItem={it => {
                    if (it === "pause") {
                        return t("settings.play_music.pause");
                    } else {
                        return t("settings.play_music.skip_to_next");
                    }
                }}
            ></RadioGroupSettingItem>
            <RadioGroupSettingItem
                label={t("settings.play_music.double_click_music_list")}
                keyPath="playMusic.clickMusicList"
                options={["normal", "replace"]}
                renderItem={it => {
                    if (it === "normal") {
                        return t("settings.play_music.add_music_to_playlist");
                    } else {
                        return t("settings.play_music.replace_playlist_with_musiclist");
                    }
                }}

            ></RadioGroupSettingItem>
            <ListBoxSettingItem
                label={t("settings.play_music.audio_output_device")}
                keyPath="playMusic.audioOutputDevice"
                renderItem={(item) => {
                    return item ? item.label : t("common.default");
                }}
                width={"320px"}
                onChange={async (evt, item) => {
                    evt.preventDefault();
                    const request = ++latestDeviceChange.current;
                    const change = deviceChanges.current.then(async () => {
                        if (request !== latestDeviceChange.current) return;
                        const previous = AppConfig.getConfig("playMusic.audioOutputDevice");
                        if (await trackPlayer.setAudioOutputDevice(item?.deviceId) === false) {
                            if (request === latestDeviceChange.current) toast.error(t("settings.common.device_failed"));
                            return;
                        }
                        if (request !== latestDeviceChange.current) return;
                        const saved = await AppConfig.setConfig({
                            "playMusic.audioOutputDevice": item?.toJSON?.() ?? null,
                        });
                        // The next native change starts after this rollback; an
                        // older failed save cannot undo a newer selected sink.
                        if (saved === false) await trackPlayer.setAudioOutputDevice(previous?.deviceId);
                    });
                    deviceChanges.current = change.catch(error => {
                        console.error("Audio output change failed", error);
                        if (request === latestDeviceChange.current) toast.error(t("settings.common.device_failed"));
                    });
                    await deviceChanges.current;
                }}
                options={audioDevices}
            ></ListBoxSettingItem>
            <RadioGroupSettingItem
                label={t("settings.play_music.when_device_removed")}
                keyPath="playMusic.whenDeviceRemoved"
                renderItem={it => {
                    if (it === "pause") {
                        return t("settings.play_music.pause");
                    } else {
                        return t("settings.play_music.continue_playing");
                    }
                }}
                options={["pause", "play"]}
            ></RadioGroupSettingItem>
        </div>
    );
}
