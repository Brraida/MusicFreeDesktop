module.exports = async () => {
    const path = require('node:path');
    const assert = require('node:assert/strict');
    const req = require('node:module').createRequire(path.resolve('package.json'));
    const { load } = req('./scripts/tests/source-loader.cjs');
    const constants = load('src/common/constant.ts');
    const media = load('src/common/media-util.ts', { './constant': constants });
    const db = load('src/renderer/core/db/music-sheet-db.ts', { '@/common/constant': constants }).default;
    const favorite = { id: 'favorite', title: 'Favorite', platform: 'local', musicList: [] };
    const second = { ...favorite, id: 'second', musicList: [] };
    await db.sheets.bulkPut([favorite, second]);
    const backend = load('src/renderer/core/music-sheet/backend/index.ts', {
        '@/common/constant': constants, nanoid: { nanoid: () => 'test-sheet' },
        '../../db/music-sheet-db': db, '../common/default-sheet': favorite,
        '@/common/media-util': media,
        '@/renderer/utils/user-perference': { getUserPreferenceIDB: async () => [], setUserPreferenceIDB: async () => {} },
    });
    await backend.queryAllSheets();
    const A = { id: 'A', platform: 'test', title: 'A' }, B = { ...A, id: 'B' }, C = { ...A, id: 'C' };
    const ref = constants.musicRefSymbol;
    await Promise.all(Array.from({ length: 20 }, () => backend.addMusicToSheet([A, A, B, B], favorite.id)));
    assert.equal((await db.sheets.get(favorite.id)).musicList.length, 2);
    assert.equal((await db.musicStore.get([A.platform, A.id]))[ref], 1);
    assert.equal((await db.musicStore.get([B.platform, B.id]))[ref], 1);
    await backend.addMusicToSheet([A, A], second.id);
    assert.equal((await db.musicStore.get([A.platform, A.id]))[ref], 2);
    await Promise.all([backend.addMusicToSheet(C, favorite.id), backend.removeMusicFromSheet([A, A], favorite.id)]);
    assert.deepEqual(new Set((await db.sheets.get(favorite.id)).musicList.map(item => item.id)), new Set(['B', 'C']));
    assert.equal((await db.musicStore.get([A.platform, A.id]))[ref], 1);
    assert.equal(backend.isFavoriteMusic(A), false); assert.equal(backend.isFavoriteMusic(C), true);
    // Fail after music records were written; real IndexedDB must roll back both stores.
    const before = JSON.stringify(backend.getAllSheets());
    const originalPut = db.sheets.put.bind(db.sheets);
    db.sheets.put = async () => { throw new Error('Injected sheet write failure'); };
    const failure = { ...A, id: 'failed' };
    await assert.rejects(() => backend.addMusicToSheet(failure, favorite.id));
    assert.equal(await db.musicStore.get([failure.platform, failure.id]), undefined);
    assert.equal(backend.isFavoriteMusic(failure), false);
    assert.equal(JSON.stringify(backend.getAllSheets()), before);
    db.sheets.put = originalPut;
    const originalDelete = db.sheets.delete.bind(db.sheets);
    db.sheets.delete = async () => { throw new Error('Injected delete failure'); };
    await assert.rejects(() => backend.removeSheet(second.id));
    assert.equal((await db.musicStore.get([A.platform, A.id]))[ref], 1);
    assert.equal(JSON.stringify(backend.getAllSheets()), before);
    db.sheets.delete = originalDelete;
    await backend.clearSheet(favorite.id);
    assert.equal((await db.sheets.get(favorite.id)).musicList.length, 0);
    assert.equal(await db.musicStore.get([B.platform, B.id]), undefined);
    assert.equal(backend.isFavoriteMusic(C), false);
    await backend.removeSheet(second.id);
    assert.equal(await db.musicStore.get([A.platform, A.id]), undefined);
    assert.equal(await db.sheets.get(second.id), undefined);
    db.close();
    return 'PASS: actual Windows IndexedDB duplicate/concurrent additions, add-remove races, reference counts, favorite index, clear/delete and transaction rollback';
};
