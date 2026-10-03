import { ChildProcess, fork } from "child_process";
import { app, ipcMain } from "electron";
import { IWindowManager } from "@/types/main/window-manager";
import { ServiceName } from "@shared/service-manager/common";
import getResourcePath from "@/common/get-resource-path";
import { randomBytes } from "crypto";


class ServiceInstance {
    private serviceProcess: ChildProcess = null;
    private retryTimeOut = 6000;
    private started = false;
    private restartTimer: ReturnType<typeof setTimeout> | null = null;
    private subprocessName: string;

    private hostChangeCallback: (host: string | null) => void;

    public serviceName: string;

    constructor(serviceName: string, subprocessPath: string) {
        this.serviceName = serviceName;
        this.subprocessName = subprocessPath;
    }


    onHostChange(callback: (host: string | null) => void) {
        this.hostChangeCallback = callback;
    }


    start() {
        if (this.started) {
            return;
        }
        this.started = true;
        this.launch();
    }

    private launch() {
        if (!this.started || this.serviceProcess) {
            return;
        }
        const servicePath = getResourcePath(".service/" + this.subprocessName + ".js");
        const token = randomBytes(32).toString("hex");
        let child: ChildProcess;
        try {
            child = fork(servicePath, [], {
                env: { ...process.env, MUSICFREE_FORWARDER_TOKEN: token },
            });
        } catch {
            this.scheduleRestart();
            return;
        }
        this.serviceProcess = child;

        interface IMessage {
            type: "port",
            port: number
        }

        child.on("message", (msg: IMessage) => {
            if (child !== this.serviceProcess || !this.started || msg?.type !== "port" ||
                !Number.isInteger(msg.port) || msg.port < 1 || msg.port > 65535) {
                return;
            }
            this.retryTimeOut = 6000;
            const host = `http://127.0.0.1:${msg.port}/?token=${token}`;
            this.hostChangeCallback?.(host);
        });

        const ended = () => {
            if (child !== this.serviceProcess) {
                return;
            }
            this.serviceProcess = null;
            this.hostChangeCallback?.(null);
            if (!child.killed) {
                child.kill();
            }
            this.scheduleRestart();
        };
        child.on("error", ended);
        child.on("exit", ended);
    }

    private scheduleRestart() {
        if (!this.started || this.restartTimer) {
            return;
        }
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            this.launch();
        }, this.retryTimeOut);
        this.retryTimeOut = Math.min(300000, this.retryTimeOut * 2);
    }

    stop() {
        this.started = false;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        const child = this.serviceProcess;
        this.serviceProcess = null;
        if (child && !child.killed) {
            child.kill();
        }
        this.retryTimeOut = 6000;
        this.hostChangeCallback?.(null);
    }
}

interface IServiceData {
    instance: ServiceInstance;
    host: string | null;
}

class ServiceManager {
    private windowManager: IWindowManager;
    private serviceMap = new Map<ServiceName, IServiceData>();


    private addService(serviceName: ServiceName) {
        const instance = new ServiceInstance(serviceName, serviceName);
        this.serviceMap.set(serviceName, { instance, host: null });
        instance.onHostChange((host) => {
            const mainWindow = this.windowManager?.mainWindow;
            this.serviceMap.get(serviceName).host = host;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("@shared/service-manager/host-changed", serviceName, host);
            }
        });

        return instance;
    }

    startService(serviceName: ServiceName) {
        this.serviceMap.get(serviceName)?.instance?.start?.();
    }

    stopService(serviceName: ServiceName) {
        this.serviceMap.get(serviceName)?.instance?.stop?.();
    }

    setup(windowManager: IWindowManager) {
        this.windowManager = windowManager;

        app.on("before-quit", () => {
            this.serviceMap.forEach((val) => val.instance.stop());
        });

        // put services here
        this.addService(ServiceName.RequestForwarder).start();


        ipcMain.handle("@shared/service-manager/get-service-hosts", () => {
            const serviceHosts: Record<string, string> = {};
            this.serviceMap.forEach((val, key) => {
                if (val.host) {
                    serviceHosts[key] = val.host;
                }
            });
            return serviceHosts;
        });


    }
}


export default new ServiceManager();
