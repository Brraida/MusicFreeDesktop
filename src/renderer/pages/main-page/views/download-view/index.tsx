import { Tab } from "@headlessui/react";
import "./index.scss";
import Downloaded from "./components/Downloaded";
import Downloading from "./components/Downloading";
import { useTranslation } from "react-i18next";
import Downloader from "@/renderer/core/downloader";
import { toast } from "react-toastify";
import { useState } from "react";

export default function DownloadView() {
    const { t } = useTranslation();
    const queueState = Downloader.useQueueState();
    const tasks = Downloader.useDownloadingMusicList();
    const [refreshing, setRefreshing] = useState(false);

    async function refreshFiles() {
        setRefreshing(true);
        try {
            await Downloader.refreshDownloadedMusicList();
        } catch (error) {
            toast.error(error?.message ?? t("download_page.refresh_failed"));
        } finally {
            setRefreshing(false);
        }
    }

    async function togglePause() {
        try {
            if (queueState.paused) {
                await Downloader.resumeAllDownloads();
            } else {
                await Downloader.pauseAllDownloads();
            }
        } catch (error) {
            toast.error(error?.message ?? t("download_page.control_failed"));
        }
    }

    return (
        <div
            id="page-container"
            className="page-container download-view--container"
        >
            <div className="download-queue-controls">
                <button type="button" disabled={refreshing} onClick={refreshFiles}>
                    {t(refreshing ? "download_page.refreshing_files" : "download_page.refresh_files")}
                </button>
                <button
                    type="button"
                    disabled={queueState.changing || (!queueState.paused && !tasks.length)}
                    onClick={togglePause}
                >
                    {t(queueState.changing
                        ? "download_page.changing"
                        : queueState.paused ? "download_page.resume_all" : "download_page.pause_all")}
                </button>
                <button
                    type="button"
                    disabled={queueState.changing || !tasks.length}
                    onClick={() => Downloader.retryFailedDownloads()}
                >
                    {t("download_page.retry_failed")}
                </button>
                {queueState.paused && <span>{t("download_page.pause_hint")}</span>}
            </div>
            <Tab.Group>
                <Tab.List className="tab-list-container">
                    <Tab as="div" className="tab-list-item">
                        {t("common.downloaded")}
                    </Tab>
                    <Tab as="div" className="tab-list-item">
                        {t("common.downloading")}
                    </Tab>
                </Tab.List>
                <Tab.Panels className={"tab-panels-container"}>
                    <Tab.Panel className="tab-panel-container">
                        <Downloaded></Downloaded>
                    </Tab.Panel>
                    <Tab.Panel className="tab-panel-container">
                        <Downloading></Downloading>
                    </Tab.Panel>
                </Tab.Panels>
            </Tab.Group>
        </div>
    );
}
