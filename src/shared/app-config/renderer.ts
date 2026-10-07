import { IAppConfig } from "@/types/app-config";
import { toast } from "react-toastify";
import i18next from "i18next";
import defaultAppConfig from "@shared/app-config/default-app-config";


interface IMod {
    syncConfig(): Promise<IAppConfig>;

    setConfig(config: IAppConfig): Promise<{ success: boolean; config: IAppConfig; error?: string }>;

    onConfigUpdate(callback: (config: IAppConfig) => void): void;

    reset(): Promise<{ success: boolean; config: IAppConfig; error?: string }>;
}

const mod = window["@shared/app-config" as any] as unknown as IMod;

class AppConfig {
    private config: IAppConfig = {};

    public initialized = false;
    private configRevision = 0;

    private updateCallbacks: Set<(patch: IAppConfig, config: IAppConfig) => void> = new Set();

    private notifyCallbacks(patch: IAppConfig) {
        for (const callback of this.updateCallbacks) {
            try {
                callback(patch, this.config);
            } catch (error) {
                console.error("Configuration subscriber failed", error);
            }
        }
    }

    async setup() {
        let pending: IAppConfig = {};
        let loading = true;
        mod.onConfigUpdate((patch) => {
            ++this.configRevision;
            if (loading) {
                pending = { ...pending, ...patch }; return;
            }
            this.config = { ...defaultAppConfig, ...this.config, ...patch };
            this.notifyCallbacks(patch);
        });
        this.config = { ...await mod.syncConfig(), ...pending };
        loading = false;
        this.initialized = true;
        this.notifyCallbacks(this.config);
    }

    public onConfigUpdate(callback: (patch: IAppConfig, config: IAppConfig) => void) {
        this.updateCallbacks.add(callback);
    }

    public offConfigUpdate(callback: (patch: IAppConfig, config: IAppConfig) => void) {
        this.updateCallbacks.delete(callback);
    }

    public getAllConfig() {
        return this.config;
    }

    public getConfig<T extends keyof IAppConfig>(key: T): IAppConfig[T] {
        return this.config[key];
    }

    public setConfig(data: IAppConfig): Promise<boolean> {
        return this.save(() => mod.setConfig(data));
    }

    public reset(): Promise<boolean> {
        return this.save(() => mod.reset());
    }

    private async save(work: () => Promise<{ success: boolean; config: IAppConfig; error?: string }>) {
        try {
            const result = await work();
            if (result?.success !== true) {
                const revision = this.configRevision;
                const latest = await mod.syncConfig();
                if (revision === this.configRevision) this.config = latest;
                this.notifyCallbacks(this.config);
                throw new Error(result?.error || "Invalid configuration acknowledgement");
            }
            // Successful state arrives through ordered broadcasts. An old invoke
            // reply must not overwrite a newer configuration broadcast.
            return true;
        } catch (error) {
            console.error("Configuration save failed", error);
            toast.error(i18next.t("settings.common.save_failed", { reason: error.message }));
            return false;
        }
    }

}

export default new AppConfig();
