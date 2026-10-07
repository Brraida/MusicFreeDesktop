import {
    ColumnDef,
    createColumnHelper,
    flexRender,
    getSortedRowModel,
    SortingState,
    useReactTable,
} from "@tanstack/react-table";

import "./index.scss";
import Tag from "../Tag";
import MusicDuration from "./MusicDuration";
import MusicSheet from "@/renderer/core/music-sheet";
import trackPlayer from "@renderer/core/track-player";
import Condition, { IfTruthy } from "../Condition";
import Empty from "../Empty";
import MusicFavorite from "../MusicFavorite";
import MusicDownloaded from "../MusicDownloaded";
import { localPluginName, RequestStateCode } from "@/common/constant";
import BottomLoadingState from "../BottomLoadingState";
import { IContextMenuItem, showContextMenu } from "../ContextMenu";
import { getInternalData, getMediaPrimaryKey } from "@/common/media-util";
import { CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showModal } from "../Modal";
import useVirtualList from "@/hooks/useVirtualList";
import hotkeys from "hotkeys-js";
import Downloader from "@/renderer/core/downloader";
import { toast } from "react-toastify";
import SwitchCase from "../SwitchCase";
import SvgAsset from "../SvgAsset";
import musicSheetDB from "@/renderer/core/db/music-sheet-db";
import DragReceiver, { startDrag } from "../DragReceiver";
import { i18n } from "@/shared/i18n/renderer";
import isLocalMusic from "@/renderer/utils/is-local-music";
import AppConfig from "@shared/app-config/renderer";
import cachedMusicRows from "./row-model";
import { shellUtil } from "@shared/utils/renderer";

interface IMusicListProps {
    /** 展示的播放列表 */
    musicList: IMusic.IMusicItem[];
    /** 实际的播放列表 */
    getAllMusicItems?: () => IMusic.IMusicItem[];
    /** 音乐列表所属的歌单信息 */
    musicSheet?: IMusic.IMusicSheetItem;
    // enablePagination?: boolean; // 分页/虚拟长列表
    state?: RequestStateCode; // 网络状态
    doubleClickBehavior?: "replace" | "normal"; // 双击行为
    onPageChange?: (page?: number) => void; // 分页
    /** 虚拟滚动参数 */
    virtualProps?: {
        offsetHeight?: number | (() => number); // 距离顶部的高度
        getScrollElement?: () => HTMLElement; // 滚动
        fallbackRenderCount?: number;
    };
    containerStyle?: CSSProperties;
    hideRows?: Array<
        "like" | "index" | "title" | "artist" | "album" | "duration" | "platform"
    >;
    /** 允许拖拽 */
    enableDrag?: boolean;
    /** 拖拽结束 */
    onDragEnd?: (newMusicList: IMusic.IMusicItem[]) => void;
    /** context */
    contextMenu?: IContextMenuItem[];
}

const columnHelper = createColumnHelper<IMusic.IMusicItem>();
const columnDef: ColumnDef<IMusic.IMusicItem>[] = [
    columnHelper.display({
        id: "like",
        size: 42,
        minSize: 42,
        maxSize: 42,
        cell: (info) => (
            <div className="music-list-operations" onClick={(event) => event.stopPropagation()}>
                <MusicFavorite musicItem={info.row.original} size={18}></MusicFavorite>
                <MusicDownloaded musicItem={info.row.original}></MusicDownloaded>
            </div>
        ),
        enableResizing: false,
        enableSorting: false,
    }),
    columnHelper.accessor((_, index) => index + 1, {
        cell: (info) => info.getValue(),
        header: "#",
        id: "index",
        minSize: 40,
        maxSize: 40,
        size: 40,
        enableResizing: false,
    }),
    columnHelper.accessor("title", {
        header: () => i18n.t("media.media_title"),
        size: 250,
        maxSize: 300,
        minSize: 100,
        cell: (info) => {
            const title = info?.getValue?.();
            return <span title={title}>{title}</span>;
        },
        // @ts-ignore
        fr: 3,
    }),

    columnHelper.accessor("artist", {
        header: () => i18n.t("media.media_type_artist"),
        size: 130,
        maxSize: 200,
        minSize: 60,
        cell: (info) => <span title={info.getValue()}>{info.getValue()}</span>,
        // @ts-ignore
        fr: 2,
    }),
    columnHelper.accessor("album", {
        header: () => i18n.t("media.media_type_album"),
        size: 120,
        maxSize: 200,
        minSize: 60,
        cell: (info) => <span title={info.getValue()}>{info.getValue()}</span>,
        // @ts-ignore
        fr: 2,
    }),
    columnHelper.accessor("duration", {
        header: () => i18n.t("media.media_duration"),
        size: 64,
        maxSize: 150,
        minSize: 48,
        cell: (info) => <MusicDuration key={getMediaPrimaryKey(info.row.original)} musicItem={info.row.original} />,
        // @ts-ignore
        fr: 1,
    }),
    columnHelper.accessor("platform", {
        header: () => i18n.t("media.media_platform"),
        size: 100,
        minSize: 80,
        maxSize: 300,
        cell: (info) => <Tag fill>{info.getValue()}</Tag>,
        // @ts-ignore
        fr: 1,
    }),
];

const estimizeItemHeight = 2.6 * 13; // lineheight 2.6rem

export function showMusicContextMenu(
    musicItems: IMusic.IMusicItem | IMusic.IMusicItem[],
    x: number,
    y: number,
    sheetType?: string,
) {
    const menuItems: IContextMenuItem[] = [];
    const isArray = Array.isArray(musicItems);
    if (!isArray) {
        menuItems.push(
            {
                title: `ID: ${getMediaPrimaryKey(musicItems)}`,
                icon: "identification",
            },
            {
                title: `${i18n.t("media.media_type_artist")}: ${
                    musicItems.artist ?? i18n.t("media.unknown_artist")
                }`,
                icon: "user",
            },
            {
                title: `${i18n.t("media.media_type_album")}: ${
                    musicItems.album ?? i18n.t("media.unknown_album")
                }`,
                icon: "album",
                show: !!musicItems.album,
            },
            {
                divider: true,
            },
        );
    }
    menuItems.push(
        {
            title: i18n.t("music_list_context_menu.next_play"),
            icon: "motion-play",
            onClick() {
                trackPlayer.addNext(musicItems);
            },
        },
        {
            title: i18n.t("music_list_context_menu.add_to_my_sheets"),
            icon: "document-plus",
            onClick() {
                showModal("AddMusicToSheet", {
                    musicItems: musicItems,
                });
            },
        },
        {
            title: i18n.t("music_list_context_menu.remove_from_sheet"),
            icon: "trash",
            show: !!sheetType && sheetType !== "play-list",
            onClick() {
                MusicSheet.frontend.removeMusicFromSheet(musicItems, sheetType);
            },
        },
        {
            title: i18n.t("common.remove"),
            icon: "trash",
            show: sheetType === "play-list",
            onClick() {
                trackPlayer.removeMusic(musicItems);
            },
        },
    );

    menuItems.push(
        {
            title: i18n.t("common.download"),
            icon: "array-download-tray",
            show: isArray
                ? !musicItems.every(
                    (item) => isLocalMusic(item) || Downloader.isDownloaded(item),
                )
                : !isLocalMusic(musicItems) && !Downloader.isDownloaded(musicItems),
            onClick() {
                Downloader.startDownload(musicItems);
            },
        },
        {
            title: i18n.t("music_list_context_menu.delete_local_download"),
            icon: "trash",
            show:
                (isArray && musicItems.every((it) => Downloader.isDownloaded(it))) ||
                (!isArray && Downloader.isDownloaded(musicItems)),
            async onClick() {
                const [isSuccess, info] = await Downloader.removeDownloadedMusic(
                    musicItems,
                    true,
                );
                if (isSuccess) {
                    if (isArray) {
                        toast.success(
                            i18n.t(
                                "music_list_context_menu.delete_local_downloaded_songs_success",
                                {
                                    musicNums: musicItems.length,
                                },
                            ),
                        );
                    } else {
                        toast.success(
                            i18n.t(
                                "music_list_context_menu.delete_local_downloaded_song_success",
                                {
                                    songName: (musicItems as IMusic.IMusicItem).title,
                                },
                            ),
                        );
                    }
                } else if (info?.msg) {
                    toast.error(info.msg);
                }
            },
        },
        {
            title: i18n.t(
                "music_list_context_menu.reveal_local_music_in_file_explorer",
            ),
            icon: "folder-open",
            show:
                !isArray &&
                (Downloader.isDownloaded(musicItems) ||
                    musicItems?.platform === localPluginName),
            async onClick() {
                try {
                    if (!isArray) {
                        let realTimeMusicItem = musicItems;
                        if (musicItems.platform !== localPluginName) {
                            realTimeMusicItem = await musicSheetDB.musicStore.get([
                                musicItems.platform,
                                musicItems.id,
                            ]);
                        }

                        const downloadPath = getInternalData<IMusic.IMusicItemInternalData>(
                            realTimeMusicItem,
                            "downloadData",
                        )?.path;

                        const result = await shellUtil.showItemInFolder(downloadPath);
                        if (!result) {
                            throw new Error();
                        }
                    }
                } catch (e) {
                    toast.error(
                        `${i18n.t(
                            "music_list_context_menu.reveal_local_music_in_file_explorer_fail",
                        )} ${e?.message ?? ""}`,
                    );
                }
            },
        },
    );

    showContextMenu({
        x,
        y,
        menuItems,
    });
}

function _MusicList(props: IMusicListProps) {
    const {
        musicList,
        state = RequestStateCode.FINISHED,
        onPageChange,
        musicSheet,
        virtualProps,
        // getAllMusicItems,
        doubleClickBehavior,
        containerStyle,
        hideRows,
        enableDrag,
        onDragEnd,
    } = props;

    const [sorting, setSorting] = useState<SortingState>([]);

    const musicListRef = useRef(musicList);
    musicListRef.current = musicList;
    const [batchSelecting, setBatchSelecting] = useState(false);
    const columnShownRef = useRef(
        AppConfig.getConfig("normal.musicListColumnsShown").reduce(
            (prev, curr) => ({
                ...prev,
                [curr]: false,
            }),
            {},
        ),
    );

    const table = useReactTable({
        debugAll: false,
        data: musicList,
        columns: columnDef,
        state: {
            sorting: sorting,
            columnVisibility: hideRows
                ? hideRows.reduce((prev, curr) => ({ ...prev, [curr]: false }), {
                    ...columnShownRef.current,
                })
                : columnShownRef.current,
        },
        onSortingChange: setSorting,
        getCoreRowModel: cachedMusicRows(),
        getSortedRowModel: getSortedRowModel(),
    });

    const tableContainerRef = useRef<HTMLDivElement>();
    const tableRef = useRef<HTMLTableElement>();
    const virtualController = useVirtualList({
        data: table.getRowModel().rows,
        getScrollElement: virtualProps?.getScrollElement,
        offsetHeight: () => tableRef.current?.offsetTop ?? 0,
        estimateItemHeight: estimizeItemHeight,
        fallbackRenderCount: !(
            virtualProps?.getScrollElement
        )
            ? -1
            : virtualProps?.fallbackRenderCount ?? 50,
    });

    // Identify songs by their source and ID so selection survives sorting and pagination.
    const [activeItems, setActiveItems] = useState<Set<string>>(new Set());
    const lastActiveKeyRef = useRef<string>();
    const rows = table.getRowModel().rows;
    const selectedItems = useMemo(() => activeItems.size ? rows
        .filter((row) => activeItems.has(getMediaPrimaryKey(row.original)))
        .map((row) => row.original) : [], [rows, activeItems]);
    const allSelected = musicList.length > 0 && selectedItems.length === musicList.length;
    const selectAllRef = useRef<HTMLInputElement>();

    useEffect(() => {
        if (selectAllRef.current) {
            selectAllRef.current.indeterminate = selectedItems.length > 0 && !allSelected;
        }
    }, [selectedItems.length, allSelected, batchSelecting]);

    useEffect(() => {
        if (!activeItems.size && !lastActiveKeyRef.current) return;
        const availableKeys = new Set(musicList.map(getMediaPrimaryKey));
        setActiveItems(previous => {
            const retained = new Set([...previous].filter(key => availableKeys.has(key)));
            return retained.size === previous.size ? previous : retained;
        });
        if (lastActiveKeyRef.current && !availableKeys.has(lastActiveKeyRef.current)) {
            lastActiveKeyRef.current = undefined;
        }
    }, [musicList]);

    useEffect(() => {
        setActiveItems(new Set());
        lastActiveKeyRef.current = undefined;
    }, [musicSheet?.platform, musicSheet?.id]);

    useEffect(() => {
        const ctrlAHandler = (evt: Event) => {
            evt.preventDefault();
            setActiveItems(new Set(musicListRef.current.map(getMediaPrimaryKey)));
        };
        hotkeys("Ctrl+A", "music-list", ctrlAHandler);

        return () => {
            hotkeys.unbind("Ctrl+A", ctrlAHandler);
        };
    }, []);

    function toggleItem(key: string) {
        setActiveItems((previous) => {
            const next = new Set(previous);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
        lastActiveKeyRef.current = key;
    }

    function selectAll() {
        setActiveItems(new Set(musicList.map(getMediaPrimaryKey)));
    }

    async function downloadSelected() {
        const result = await Downloader.startDownload(selectedItems);
        toast.info(i18n.t("music_list_batch.download_queued", {
            added: result.added,
            skipped: result.skipped,
        }));
    }

    const _onDrop = useCallback(
        (fromIndex: number, toIndex: number) => {
            if (!onDragEnd || fromIndex === toIndex) {
                // 没有移动
                return;
            }
            const newData = musicList
                .slice(0, fromIndex)
                .concat(musicList.slice(fromIndex + 1));
            newData.splice(
                fromIndex > toIndex ? toIndex : toIndex - 1,
                0,
                musicList[fromIndex],
            );
            onDragEnd?.(newData);
        },
        [onDragEnd, musicList],
    );

    return (
        <div
            className="music-list-container"
            style={containerStyle}
            ref={tableContainerRef}
            tabIndex={-1}
            onFocus={() => {
                hotkeys.setScope("music-list");
            }}
            onBlur={() => {
                hotkeys.setScope("all");
            }}
        >
            <div className="music-list-batch-toolbar">
                <button
                    type="button"
                    onClick={() => {
                        setBatchSelecting((previous) => !previous);
                        setActiveItems(new Set());
                        lastActiveKeyRef.current = undefined;
                    }}
                >
                    {i18n.t(batchSelecting ? "music_list_batch.finish" : "music_list_batch.select")}
                </button>
                {batchSelecting && (
                    <>
                        <button type="button" onClick={selectAll} disabled={!musicList.length}>
                            {i18n.t("common.select_all")}
                        </button>
                        <button
                            type="button"
                            onClick={() => setActiveItems(new Set())}
                            disabled={!selectedItems.length}
                        >
                            {i18n.t("music_list_batch.clear")}
                        </button>
                        <span aria-live="polite">
                            {i18n.t("music_list_batch.selected", { count: selectedItems.length })}
                        </span>
                        <button type="button" onClick={downloadSelected} disabled={!selectedItems.length}>
                            {i18n.t("music_list_batch.download")}
                        </button>
                        <button
                            type="button"
                            disabled={!selectedItems.length}
                            onClick={() => showModal("AddMusicToSheet", { musicItems: selectedItems })}
                        >
                            {i18n.t("music_list_batch.add_to_sheet")}
                        </button>
                        <span className="music-list-batch-hint">
                            {i18n.t("music_list_batch.loaded_only")}
                        </span>
                    </>
                )}
            </div>
            <table
                ref={tableRef}
                style={{
                    height: virtualController.totalHeight + estimizeItemHeight,
                    tableLayout: "fixed",
                }}
            >
                <thead>
                    <tr>
                        {batchSelecting && (
                            <th className="music-list-selection-cell" data-id="selection" style={{ width: 36 }}>
                                <input
                                    ref={selectAllRef}
                                    type="checkbox"
                                    checked={allSelected}
                                    disabled={!musicList.length}
                                    aria-label={i18n.t("common.select_all")}
                                    onChange={(event) => {
                                        if (event.target.checked) {
                                            selectAll();
                                        } else {
                                            setActiveItems(new Set());
                                        }
                                    }}
                                />
                            </th>
                        )}
                        {table.getHeaderGroups()[0].headers.map((header) => (
                            <th
                                key={header.id}
                                data-id={header.id}
                                style={{
                                //@ts-ignore
                                    width: header.column.columnDef.fr
                                        ? //@ts-ignore
                                        `${header.column.columnDef.fr * 100}%`
                                        : header.column.columnDef.size,
                                }}
                                onClick={header.column.getToggleSortingHandler()}
                            >
                                {flexRender(
                                    header.column.columnDef.header,
                                    header.getContext(),
                                )}
                                <div
                                    className="sort-container"
                                    data-sorting={header.column.getIsSorted() !== false}
                                >
                                    <SwitchCase.Switch switch={header.column.getIsSorted()}>
                                        <SwitchCase.Case case={"asc"}>
                                            <SvgAsset iconName="sort-asc"></SvgAsset>
                                        </SwitchCase.Case>
                                        <SwitchCase.Case case={"desc"}>
                                            <SvgAsset iconName="sort-desc"></SvgAsset>
                                        </SwitchCase.Case>
                                        <SwitchCase.Case case={false}>
                                            <SvgAsset iconName="sort"></SvgAsset>
                                        </SwitchCase.Case>
                                    </SwitchCase.Switch>
                                </div>
                                {/* <div
                  onMouseDown={header.getResizeHandler()}
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                  className={classNames({
                    resizer: true,
                    "resizer-resizing": header.column.getIsResizing(),
                  })}
                ></div> */}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody
                    style={{
                        transform: `translateY(${virtualController.startTop}px)`,
                    }}
                >
                    {virtualController.virtualItems.map((virtualItem, index) => {
                        const row = virtualItem.dataItem;

                        if (!row.original) {
                            return null;
                        }
                        // todo 拆出一个组件
                        return (
                            <tr
                                key={getMediaPrimaryKey(row.original)}
                                data-active={
                                    activeItems.has(getMediaPrimaryKey(row.original))
                                }
                                onContextMenu={(e) => {
                                    const key = getMediaPrimaryKey(row.original);
                                    if (activeItems.has(key) && selectedItems.length > 1) {
                                        showMusicContextMenu(
                                            selectedItems,
                                            e.clientX,
                                            e.clientY,
                                            musicSheet?.platform === localPluginName ? musicSheet.id : undefined,
                                        );
                                    } else {
                                        lastActiveKeyRef.current = key;
                                        setActiveItems(new Set([key]));
                                        showMusicContextMenu(
                                            row.original,
                                            e.clientX,
                                            e.clientY,
                                            musicSheet?.platform === localPluginName ? musicSheet.id : undefined,
                                        );
                                    }
                                }}
                                onClick={(event) => {
                                    const key = getMediaPrimaryKey(row.original);
                                    if (event.shiftKey) {
                                        const anchorIndex = rows.findIndex((item) =>
                                            getMediaPrimaryKey(item.original) === lastActiveKeyRef.current);
                                        const start = Math.min(Math.max(anchorIndex, 0), virtualItem.rowIndex);
                                        const end = Math.max(Math.max(anchorIndex, 0), virtualItem.rowIndex);
                                        const range = rows.slice(start, end + 1)
                                            .map((item) => getMediaPrimaryKey(item.original));
                                        setActiveItems((previous) => new Set(batchSelecting ? [...previous, ...range] : range));
                                    } else if (batchSelecting || event.ctrlKey || event.metaKey) {
                                        toggleItem(key);
                                    } else {
                                        setActiveItems(new Set([key]));
                                        lastActiveKeyRef.current = key;
                                    }
                                }}
                                onDoubleClick={() => {
                                    if (batchSelecting) {
                                        return;
                                    }
                                    const config =
                                    doubleClickBehavior ??
                                    AppConfig.getConfig("playMusic.clickMusicList");
                                    if (config === "replace") {
                                        trackPlayer.playMusicWithReplaceQueue(
                                            table.getRowModel().rows.map((it) => it.original),
                                            row.original,
                                        );
                                    } else {
                                        trackPlayer.playMusic(row.original);
                                    }
                                }}
                                draggable={enableDrag && !batchSelecting}
                                onDragStart={(e) => {
                                // TODO
                                // if(activeItems) {

                                    // }
                                    startDrag(e, virtualItem.rowIndex, "musiclist");
                                }}
                            >
                                {batchSelecting && (
                                    <td className="music-list-selection-cell" style={{ width: 36 }}>
                                        <input
                                            type="checkbox"
                                            checked={activeItems.has(getMediaPrimaryKey(row.original))}
                                            aria-label={i18n.t("music_list_batch.select_song", { title: row.original.title })}
                                            onClick={(event) => event.stopPropagation()}
                                            onDoubleClick={(event) => event.stopPropagation()}
                                            onChange={() => toggleItem(getMediaPrimaryKey(row.original))}
                                        />
                                    </td>
                                )}
                                {row.getVisibleCells().map((cell) => (
                                    <td
                                        key={cell.id}
                                        data-id={cell.column.id}
                                        style={{
                                        //@ts-ignore
                                            width: cell.column.columnDef.fr
                                                ? //@ts-ignore
                                                `${cell.column.columnDef.fr * 100}%`
                                                : cell.column.columnDef.size,
                                        }}
                                    >
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </td>
                                ))}
                                <IfTruthy condition={enableDrag}>
                                    <IfTruthy condition={index === 0}>
                                        <DragReceiver
                                            position="top"
                                            rowIndex={virtualItem.rowIndex}
                                            onDrop={_onDrop}
                                            tag="musiclist"
                                            insideTable
                                        ></DragReceiver>
                                    </IfTruthy>
                                    <DragReceiver
                                        position="bottom"
                                        rowIndex={virtualItem.rowIndex + 1}
                                        onDrop={_onDrop}
                                        tag="musiclist"
                                        insideTable
                                    ></DragReceiver>
                                </IfTruthy>
                            </tr>
                        );
                    })}
                </tbody>
                <tfoot
                    style={{
                        height:
                            virtualController.totalHeight -
                            virtualController.virtualItems.length * estimizeItemHeight,
                    }}
                ></tfoot>
            </table>
            <Condition
                condition={musicList.length === 0}
                falsy={
                    <BottomLoadingState
                        state={state}
                        onLoadMore={onPageChange}
                    ></BottomLoadingState>
                }
            >
                <Empty></Empty>
            </Condition>
        </div>
    );
}

export default memo(_MusicList);
