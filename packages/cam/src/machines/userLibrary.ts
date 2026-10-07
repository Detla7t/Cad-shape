// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Logger } from "@chili3d/core";
import type { MachineProfileData } from "../model/machine";
import { checkMachineProfile } from "./profileJson";

/**
 * The per-browser machine library: profiles a user saved for every document, kept in
 * `localStorage`. A convenience, like a remembered panel width — the document keeps its
 * own copy of each profile its setups use (`CamStudioNode.machines`), so a document opened
 * elsewhere never depends on this library. Every access is guarded: storage may be absent
 * (private windows, tests) or full.
 */
export const USER_MACHINES_KEY = "chili3d.cam.machines";

type Listener = () => void;

export class UserMachineLibrary {
    private readonly listeners = new Set<Listener>();
    /** The last parse, by the stored text: machine lookups run on every status check. */
    private cache: { text: string; profiles: MachineProfileData[] } | undefined;

    constructor(private readonly key = USER_MACHINES_KEY) {}

    list(): MachineProfileData[] {
        let text: string | null = null;
        try {
            text = globalThis.localStorage?.getItem(this.key) ?? null;
        } catch {
            return [];
        }
        if (text === null) return [];
        if (this.cache?.text === text) return [...this.cache.profiles];
        let profiles: MachineProfileData[] = [];
        try {
            const parsed: unknown = JSON.parse(text);
            if (Array.isArray(parsed)) {
                profiles = parsed.flatMap((item) => {
                    const checked = checkMachineProfile(item);
                    return checked.isOk ? [checked.value] : [];
                });
            }
        } catch (error) {
            Logger.warn("CAM: the user machine library is unreadable", error);
        }
        this.cache = { text, profiles };
        return [...profiles];
    }

    get(id: string): MachineProfileData | undefined {
        return this.list().find((profile) => profile.id === id);
    }

    /** Adds or replaces (by id) a profile; false when the browser refuses to store it. */
    save(profile: MachineProfileData): boolean {
        const profiles = this.list().filter((x) => x.id !== profile.id);
        profiles.push(profile);
        return this.write(profiles);
    }

    remove(id: string): boolean {
        return this.write(this.list().filter((x) => x.id !== id));
    }

    onChanged(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private write(profiles: readonly MachineProfileData[]): boolean {
        try {
            globalThis.localStorage?.setItem(this.key, JSON.stringify(profiles));
        } catch (error) {
            Logger.warn("CAM: the user machine library could not be saved", error);
            return false;
        }
        for (const listener of [...this.listeners]) listener();
        return true;
    }
}

/** The browser's library. */
export const userMachines = new UserMachineLibrary();
