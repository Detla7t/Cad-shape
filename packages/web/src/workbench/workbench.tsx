// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

"use client";

import { findDocumentTemplate, type IApplication, Logger, PubSub } from "@chili3d/core";
import { ChiliHost, LoadingScreen } from "@chili3d/react";
import { parseStartupParams } from "../startupParams";
import { bootApplication } from "./bootApplication";

/** Startup actions from the URL, run once per page load. */
let started = false;

async function handleReady(app: IApplication) {
    if (started) return;
    started = true;
    const search = window.location.search;
    const { plugins, fileUrl } = parseStartupParams(search);
    for (const plugin of plugins) {
        Logger.info(`loading plugin from: ${plugin}`);
        await app.pluginManager.loadFromUrl(plugin);
    }
    if (fileUrl) {
        Logger.info(`loading file from: ${fileUrl}`);
        await app.loadFileFromUrl(fileUrl);
    }
    // `/?template=end-cap-configurator`: a copy of a public template, saved to the user's library.
    const templateId = new URLSearchParams(search).get("template");
    if (templateId) await openTemplate(app, templateId);
}

async function openTemplate(app: IApplication, id: string) {
    const template = findDocumentTemplate(id);
    if (template === undefined) {
        PubSub.default.pub("displayError", `No public template is called "${id}".`);
        return;
    }
    const created = await template.create(app);
    if (!created.isOk) {
        PubSub.default.pub("displayError", created.error);
        return;
    }
    await created.value.save();
    PubSub.default.pub("displayHome", false);
}

function handleError(error: unknown) {
    alert(error instanceof Error ? error.message : String(error));
}

export function Workbench() {
    return (
        <ChiliHost
            boot={bootApplication}
            onReady={handleReady}
            onError={handleError}
            fallback={<LoadingScreen />}
            style={{ position: "fixed", inset: 0 }}
        />
    );
}
