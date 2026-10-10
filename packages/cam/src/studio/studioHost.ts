// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "@chili3d/core";
import type { EvaluationIndicators } from "@chili3d/react";
import type { CamStudioNode } from "../camStudioNode";
import type { CamGenerator } from "../context/generator";
import type { MachineProfileData } from "../model/machine";
import type { SetupData } from "../model/setup";

/** What the CAM Studio's detail panel shows for the selected setup. */
export type DetailMode = "setup" | "tools" | "operation" | "post" | "machine";

/** The view's own state — selection, open panels, drafts — never stored in the document. */
export interface StudioViewState {
    setupId?: string;
    operationId?: string;
    detail: DetailMode;
    toolId?: string;
    /** Working copy of the machine profile editor. */
    machineDraft?: MachineProfileData;
    /** The last posted program, shown under the post options. */
    posted?: { readonly setupId: string; readonly fileName: string; readonly text: string };
    /** Operations hidden from the preview. */
    readonly hidden: Set<string>;
    readonly collapsed: Set<string>;
}

/** What the panels of the CAM Studio view need from it. */
export interface StudioHost {
    readonly studio: CamStudioNode;
    readonly document: IDocument;
    readonly generator: CamGenerator;
    readonly state: StudioViewState;
    /** Evaluation indicators of the detail panel, one island per key kept across re-renders. */
    readonly detailIndicators: EvaluationIndicators;
    /** Records the setups as one undo step. */
    commit(name: string, setups: readonly SetupData[]): void;
    /** Records one changed setup as one undo step. */
    commitSetup(name: string, setup: SetupData): void;
    /** Changes the selection / panel and re-renders. */
    select(change: Partial<Pick<StudioViewState, "setupId" | "operationId" | "detail" | "toolId">>): void;
    /** Re-renders the panels (after a change to the view state). */
    refresh(): void;
    toast(message: string): void;
    download(text: string, fileName: string): void;
    /** Opens a file chooser and hands back the chosen file's text. */
    chooseFile(accept: string): Promise<string | undefined>;
}
