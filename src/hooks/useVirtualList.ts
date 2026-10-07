import {
    useMemo,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import throttle from "lodash.throttle";

interface IVirtualListProps<T> {
    /** 滚动的容器 */
    getScrollElement?: () => HTMLElement;
    /** 滚动容器的query */
    scrollElementQuery?: string;
    /** 元素高度和列表高度 */
    estimateItemHeight: number;

    /** 数据 */
    data: T[];
    /** 渲染数目 */
    renderCount?: number;
    /** 虚拟列表失效时的渲染数目 */
    fallbackRenderCount?: number;
    /** 偏移高度 */
    offsetHeight?: number | (() => number);
}

interface IVirtualItem<T> {
    /** 偏移 */
    top: number;
    /** 下标 */
    rowIndex: number;
    /** 数据 */
    dataItem: T;
}

export default function useVirtualList<T>(props: IVirtualListProps<T>) {
    const {
        estimateItemHeight,
        data,
        renderCount = 40,
        fallbackRenderCount = -1,
        getScrollElement,
        scrollElementQuery,
        offsetHeight = 0,
    } = props;
    const dataRef = useRef(data);
    dataRef.current = data;
    const optionsRef = useRef(props);
    optionsRef.current = props;

    const [virtualItems, setVirtualItems] = useState<IVirtualItem<T>[]>([]);
    const totalHeight = data.length * estimateItemHeight;

    const scrollElementRef = useRef<HTMLElement>();

    const refreshItems = useMemo(() => () => {
        const { estimateItemHeight, renderCount = 40, fallbackRenderCount = -1, offsetHeight = 0 } = optionsRef.current;
        const scrollTop = (scrollElementRef.current?.scrollTop ?? 0) -
            (typeof offsetHeight === "number" ? offsetHeight : offsetHeight());
        const index = Math.floor(scrollTop / estimateItemHeight);
        const start = Math.max(index - (index % 2 === 1 ? 3 : 2), 0);
        const count = scrollElementRef.current ? renderCount :
            fallbackRenderCount < 0 ? dataRef.current.length : fallbackRenderCount;
        const next = dataRef.current.slice(start, start + count).map((dataItem, offset) => ({
            rowIndex: start + offset, dataItem, top: (start + offset) * estimateItemHeight,
        }));
        setVirtualItems(previous => previous.length === next.length && previous.every((item, offset) =>
            item.rowIndex === next[offset].rowIndex && item.top === next[offset].top && item.dataItem === next[offset].dataItem) ? previous : next);
    }, []);
    const scrollHandler = useMemo(() => throttle(refreshItems, 32, { leading: true, trailing: true }), [refreshItems]);

    function setScrollElement(element: HTMLElement) {
        if (element === scrollElementRef.current) return;
        scrollElementRef.current?.removeEventListener("scroll", scrollHandler);
        scrollHandler.cancel();
        scrollElementRef.current = element;
        element?.addEventListener("scroll", scrollHandler);
        refreshItems();
    }

    // Inline getters change identity on every render. Only rebind if the actual
    // DOM container changes; still detect replacements returned by a stable getter.
    useLayoutEffect(() => {
        if (getScrollElement || scrollElementQuery) {
            setScrollElement(getScrollElement ? getScrollElement() : document.querySelector(scrollElementQuery));
        }
    });
    useLayoutEffect(() => () => {
        scrollElementRef.current?.removeEventListener("scroll", scrollHandler);
        scrollHandler.cancel();
        scrollElementRef.current = null;
    }, [scrollHandler]);
    useLayoutEffect(() => {
        // Data/geometry changes must not wait for a pending scroll throttle.
        scrollHandler.cancel();
        refreshItems();
    }, [data, estimateItemHeight, renderCount, fallbackRenderCount, typeof offsetHeight === "number" ? offsetHeight : undefined]);

    function scrollToIndex(index: number, behavior?: ScrollBehavior) {
        scrollElementRef.current?.scrollTo({
            top:
        (typeof offsetHeight === "number" ? offsetHeight : offsetHeight()) +
        estimateItemHeight * index,
            behavior,
        });
    }

    return {
        virtualItems,
        totalHeight,
        startTop: virtualItems[0]?.top ?? 0,
        setScrollElement,
        scrollToIndex,
    };
}
