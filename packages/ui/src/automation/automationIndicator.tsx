// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { AutomationClient } from "@chili3d/ai";
import { useObservable } from "@chili3d/react";
import style from "./automationIndicator.module.css";

export interface AutomationIndicatorProps {
    readonly client: AutomationClient;
    readonly onDisconnect: () => void;
}

/**
 * The small badge that tells the user a remote client can drive this tab: shown while the
 * automation bridge is connected, with the tool it last ran and a one-click Disconnect.
 */
export function AutomationIndicator({ client, onDisconnect }: AutomationIndicatorProps) {
    const state = useObservable(client, "state");
    const lastCall = useObservable(client, "lastCall");
    const active = useObservable(client, "activeCalls");
    if (state !== "connected") return null;
    const busy = active > 0;
    const detail = lastCall
        ? `Last remote action: ${lastCall.tool}${lastCall.isError ? " (failed)" : ""} at ${new Date(lastCall.at).toLocaleTimeString()}`
        : "No remote action yet";
    return (
        <div className={style.indicator} role="status" aria-live="polite" title={`${client.url} — ${detail}`}>
            <span className={busy ? `${style.dot} ${style.busy}` : style.dot} aria-hidden="true" />
            <span className={style.label}>
                {busy ? "Automation running…" : "Automation connected"}
                {lastCall ? <span className={style.last}> · {lastCall.tool}</span> : null}
            </span>
            <button type="button" className={style.disconnect} onClick={onDisconnect}>
                Disconnect
            </button>
        </div>
    );
}
