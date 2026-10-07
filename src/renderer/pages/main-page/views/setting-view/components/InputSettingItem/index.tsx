import AppConfig from "@shared/app-config/renderer";
import "./index.scss";
import { HTMLInputTypeAttribute, useEffect, useState } from "react";
import { IAppConfig } from "@/types/app-config";
import useAppConfig from "@/hooks/useAppConfig";

interface InputSettingItemProps<T extends keyof IAppConfig> {
    keyPath: T;
    label?: string;
    onChange?: (event: Event, val: IAppConfig[T]) => void;
    width?: number | string;
    /** 是否过滤首尾空格 */
    trim?: boolean;
    disabled?: boolean;
    type?: HTMLInputTypeAttribute;
}

export default function InputSettingItem<T extends keyof IAppConfig>(
    props: InputSettingItemProps<T>,
) {
    const {
        keyPath,
        label,
        onChange,
        width,
        type,
        disabled,
        trim,
    } = props;

    const value = useAppConfig(keyPath);
    const [tmpValue, setTmpValue] = useState<string | null>(value as string || "");

    useEffect(() => {
        setTmpValue(value == null ? "" : String(value));
    }, [value, keyPath]);

    return (
        <div
            className="setting-view--input-setting-item-container"
            style={{
                width,
            }}
        >
            {label ? <div className="input-label">{label}</div> : null}
            <input
                disabled={disabled}
                spellCheck={false}
                onChange={(e) => {
                    setTmpValue(e.target.value ?? null);
                }}
                type={type}
                onBlur={async () => {
                    if (tmpValue === null) {
                        return;
                    }
                    const event = new Event("ConfigChanged", {
                        cancelable: true,
                    });

                    if (onChange) {
                        onChange(event, tmpValue as any);
                    }

                    if (!event.defaultPrevented) {
                        const saved = await AppConfig.setConfig({
                            [keyPath]: trim ? tmpValue.trim() as any : tmpValue as any,
                        });
                        if (saved === false) {
                            const current = AppConfig.getConfig(keyPath);
                            setTmpValue(current == null ? "" : String(current));
                        }
                    }
                }}
                value={(tmpValue || "") as string}
            ></input>
        </div>
    );
}
