/** Shared by the native window sizing and its two-line renderer. */
export const LYRIC_LAYOUT = {
    nextScale: 0.78,
    lineHeight: 1.15,
    gap: 8,
    frameHeight: 60,
    minFont: 16,
    maxFont: 80,
    defaultFont: 54,
    color: "#b9eaff",
    nextColor: "#d8e5ed",
    stroke: "#123a50",
};

export function normalizeLyricFontSize(font: number) {
    return Math.max(LYRIC_LAYOUT.minFont, Math.min(
        Number.isFinite(font) ? font : LYRIC_LAYOUT.defaultFont, LYRIC_LAYOUT.maxFont,
    ));
}

export function lyricWindowHeight(font: number) {
    return Math.ceil(LYRIC_LAYOUT.frameHeight + LYRIC_LAYOUT.gap
        + normalizeLyricFontSize(font) * LYRIC_LAYOUT.lineHeight * (1 + LYRIC_LAYOUT.nextScale));
}

export function lyricFontSizeForHeight(height: number) {
    return normalizeLyricFontSize(Math.floor((height - LYRIC_LAYOUT.frameHeight - LYRIC_LAYOUT.gap)
        / (LYRIC_LAYOUT.lineHeight * (1 + LYRIC_LAYOUT.nextScale))));
}
