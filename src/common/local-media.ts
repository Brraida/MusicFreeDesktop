import { supportLocalMediaType } from "./constant";

export function isSupportedLocalMediaFile(filePath: string) {
    const normalized = filePath.toLowerCase();
    return supportLocalMediaType.some(extension => normalized.endsWith(extension));
}
