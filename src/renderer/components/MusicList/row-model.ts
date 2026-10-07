import { getCoreRowModel, RowData, RowModel, Table } from "@tanstack/react-table";

/** The music table is flat and unpaginated; data arrays are immutable snapshots. */
export default function cachedMusicRows<T extends RowData>() {
    return (table: Table<T>) => {
        const compute = getCoreRowModel<T>()(table);
        const models = new WeakMap<T[], RowModel<T>>();
        return () => {
            const data = table.options.data;
            let model = models.get(data);
            if (!model) {
                model = compute();
                models.set(data, model);
            }
            return model;
        };
    };
}
