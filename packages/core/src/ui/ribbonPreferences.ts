// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CommandKeys } from "../command";
import { type Ribbon, RibbonGroup, RibbonTab, type RibbonTabKeys } from "./ribbon";

export interface RibbonTabPreference {
    label?: string;
    custom?: boolean;
    hidden?: boolean;
    commands?: CommandKeys[];
}

export interface RibbonPreferences {
    pins?: CommandKeys[];
    tabOrder?: string[];
    tabs?: Record<string, RibbonTabPreference>;
    compact?: boolean;
    layout?: "context" | "ribbon";
}

/** Apply user additions after the installed modules have contributed their tabs. */
export function applyRibbonPreferences(ribbon: Ribbon, preferences: RibbonPreferences): void {
    if (Object.keys(preferences).length === 0) return;
    if (preferences.pins) {
        ribbon.quickCommands.clear();
        ribbon.quickCommands.push(...new Set(preferences.pins));
    }
    for (const [key, preference] of Object.entries(preferences.tabs ?? {})) {
        let tab = ribbon.tabs.find((item) => item.tabName === key);
        if (!tab && preference.custom) {
            // Custom ids have a user label, and are never sent to the localization service.
            tab = new RibbonTab(key as RibbonTabKeys);
            ribbon.tabs.push(tab);
        }
        if (!tab) continue;
        tab.groups.remove(...tab.groups.filter((group) => group.groupName === "ribbon.group.custom"));
        tab.label = preference.label ?? "";
        if (!tab.contextual) tab.visible = !preference.hidden;
        if (preference.commands?.length) {
            const group = new RibbonGroup("ribbon.group.custom", [...new Set(preference.commands)]);
            tab.groups.push(group);
        }
    }
    const order = preferences.tabOrder ?? [];
    const original = ribbon.tabs.items();
    const ordered = original.toSorted((a, b) => {
        const aIndex = order.indexOf(a.tabName);
        const bIndex = order.indexOf(b.tabName);
        return (aIndex < 0 ? order.length : aIndex) - (bIndex < 0 ? order.length : bIndex);
    });
    ribbon.tabs.clear();
    ribbon.tabs.push(...ordered);
    if (!ordered.some((tab) => tab.visible)) {
        const fallback = ordered.find((tab) => !tab.contextual);
        if (fallback) fallback.visible = true;
    }
    if (!ribbon.activeTab?.visible) ribbon.activeTab = ordered.find((tab) => tab.visible)!;
}
