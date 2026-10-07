import Dexie, { Table } from "dexie";
import EventEmitter from "eventemitter3";
import { useEffect, useState } from "react";


const ee = new EventEmitter();

enum EvtNames {
    USER_PREFERENCE_UPDATE = "USER_PREFERENCE_UPDATE",
}

export function setUserPreference<K extends keyof IUserPreference.IType>(
    key: K,
    value: IUserPreference.IType[K],
) {
    try {
        if (value === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        console.error("Preference save failed", key, error);
        return false;
    }
    try {
        ee.emit(EvtNames.USER_PREFERENCE_UPDATE, key, value);
    } catch (error) {
        console.error("Preference notification failed", key, error);
    }
    return true;
}

export function removeUserPreference(key: keyof IUserPreference.IType) {
    try {
        localStorage.removeItem(key);
    } catch (error) {
        console.error("Preference removal failed", key, error); return false;
    }
    try {
        ee.emit(EvtNames.USER_PREFERENCE_UPDATE, key, null);
    } catch (error) {
        console.error("Preference notification failed", key, error);
    }
    return true;
}

export function getUserPreference<K extends keyof IUserPreference.IType>(
    key: K,
): IUserPreference.IType[K] | null {
    let rawData = null;
    try {
        rawData = localStorage.getItem(key);
        if (!rawData || rawData === "undefined") {
            return null;
        }
        return JSON.parse(rawData);
    } catch {
        return rawData as any;
    }
}

export function useUserPreference<K extends keyof IUserPreference.IType>(
    key: K,
) {
    const [state, _setState] = useState(getUserPreference(key));

    function setState(newState: IUserPreference.IType[K] | null) {
        setUserPreference(key, newState);
    }

    useEffect(() => {
        const updateFn = (updateKey: K, value: IUserPreference.IType[K] | null) => {
            if (key === updateKey) {
                _setState(value);
            }
        };

        const updateFnStorage = (e: StorageEvent) => {
            if (e.key === key) {
                try {
                    _setState(JSON.parse(e.newValue));
                } catch {
                    _setState(e.newValue as any);
                }
            }
        };

        ee.on(EvtNames.USER_PREFERENCE_UPDATE, updateFn);
        window.addEventListener("storage", updateFnStorage);

        return () => {
            ee.off(EvtNames.USER_PREFERENCE_UPDATE, updateFn);
            window.removeEventListener("storage", updateFnStorage);
        };
    }, [key]);

    return [state, setState] as const;
}

/** 比较大的数据 */

class UserPreferenceDB extends Dexie {
    // 歌单信息，其中musiclist只存有platform和id
    perference: Table<Record<string, any>>;

    constructor() {
        super("userPerferenceDB");
        this.version(1.0).stores({
            perference: "&key",
        });
    }
}

const upDB = new UserPreferenceDB();

const dbKeyUpdateCbs = new Map<
    keyof IUserPreference.IDBType,
    Set<(...args: any) => void>
>();

export async function setUserPreferenceIDB<
    K extends keyof IUserPreference.IDBType,
>(key: K, value: IUserPreference.IDBType[K]) {
    try {
        await upDB.transaction("readwrite", upDB.perference, async () => {
            await upDB.perference.put({
                key,
                value,
            });
        });
    } catch (error) {
        console.error("IndexedDB preference save failed", key, error);
        return false;
    }
    for (const callback of [...(dbKeyUpdateCbs.get(key) ?? [])]) {
        try {
            callback(value);
        } catch (error) {
            console.error("IndexedDB preference notification failed", key, error);
        }
    }
    return true;
}

export async function getUserPreferenceIDB<
    K extends keyof IUserPreference.IDBType,
>(key: K): Promise<IUserPreference.IDBType[K] | null> {
    try {
        return (
            (
                await upDB.transaction("readonly", upDB.perference, async () => {
                    return await upDB.perference.get(key);
                })
            )?.value ?? null
        );
    } catch {
        return null;
    }
}

export function useUserPreferenceIDBValue<
    K extends keyof IUserPreference.IDBType,
>(key: K) {
    const [state, setState] = useState<IUserPreference.IDBType[K] | null>(null);

    useEffect(() => {
        let active = true, changed = false;
        const callback = (value: IUserPreference.IDBType[K]) => {
            changed = true;
            if (active) setState(value);
        };
        const callbacks = dbKeyUpdateCbs.get(key) ?? new Set();
        callbacks.add(callback);
        dbKeyUpdateCbs.set(key, callbacks);
        getUserPreferenceIDB(key).then(value => {
            if (active && !changed) setState(value);
        });
        return () => {
            active = false;
            callbacks.delete(callback);
            if (!callbacks.size) dbKeyUpdateCbs.delete(key);
        };
    }, [key]);

    return state;
}
