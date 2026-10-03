import { ReactNode, useEffect, useState } from "react";
import bootstrap from "./bootstrap";
import logger from "@shared/logger/renderer";

export default function Initialize({ children }: { children: ReactNode }) {
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
        let active = true;
        bootstrap().then(() => {
            if (!active) return;
            logger.logPerf("Bundle Bootstrap Ready");
            setReady(true);
        }).catch(reason => {
            if (!active) return;
            const failure = reason instanceof Error ? reason : new Error(String(reason));
            setError(failure);
            try {
                logger.logError("播放器初始化失败", failure);
            } catch {
                // A logging failure must not suppress the diagnostic screen.
            }
        });
        return () => {
            active = false;
        };
    }, []);

    if (error) {
        return <div className="fallback-container" role="alert">
            <div className="fallback-content">
                <div className="fallback-title">播放器初始化失败</div>
                <div className="fallback-description">请重新启动重试。如果仍然失败，请反馈下面的错误信息。</div>
                <div className="fallback-section"><div className="section-content">
                    <pre className="error-message">{error.message}</pre>
                </div></div>
                <button className="reset-button" onClick={() => window.location.reload()}>重新启动</button>
            </div>
        </div>;
    }
    if (!ready) return <div role="status">正在初始化播放器…</div>;
    return <>{children}</>;
}
