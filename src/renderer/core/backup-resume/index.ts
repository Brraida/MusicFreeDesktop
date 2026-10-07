import MusicSheet from "../music-sheet";

/** Validate the entire legacy/version-1 backup before the first database write. */
async function resume(data: string | Record<string, any>, overwrite = false) {
    const value = typeof data === "string" ? JSON.parse(data) : data;
    if (!value || typeof value !== "object" || (value.version !== undefined && value.version !== 1) || !Array.isArray(value.musicSheets)) {
        throw new Error("Invalid or unsupported playlist backup");
    }
    if (value.musicSheets.length > 10000) throw new Error("Backup contains too many playlists");
    const sheets: IMusic.IMusicSheetItem[] = [];
    let count = 0;
    let defaultSeen = false;
    for (const sheet of value.musicSheets) {
        if (!sheet || typeof sheet.title !== "string" || !Array.isArray(sheet.musicList)) throw new Error("Invalid playlist in backup");
        if (sheet.id === MusicSheet.defaultSheet.id) {
            if (defaultSeen) throw new Error("Duplicate favorite playlist in backup");
            defaultSeen = true;
        }
        count += sheet.musicList.length;
        if (count > 500000) throw new Error("Backup contains too many tracks");
        for (const item of sheet.musicList) {
            if (!item || typeof item.platform !== "string" || !item.platform.length ||
                !((typeof item.id === "string" && item.id.length > 0) || (typeof item.id === "number" && Number.isFinite(item.id)))) {
                throw new Error("Invalid track identity in backup");
            }
        }
        // Detach from mutable input. JSON snapshots match the existing backup format.
        sheets.push(JSON.parse(JSON.stringify(sheet)));
    }
    await MusicSheet.frontend.restoreSheets(sheets, overwrite);
}

export default { resume };
