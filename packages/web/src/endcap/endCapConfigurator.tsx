// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

"use client";

import { drawingBounds, writeDxf, writeSvg } from "@chili3d/drawing";
import {
    defaultWallHeight,
    endCapDxfZip,
    endCapName,
    endCapPattern,
    formatFractionalInches,
    onshapeConfiguration,
    presetEndCaps,
    toDrawing,
} from "@chili3d/fabrication";
import {
    DEFAULT_END_CAP_FORM,
    EndCapForm,
    EndCapPreview,
    endCapFormOf,
    endCapFromSearchParams,
    endCapSearchParams,
    readEndCapForm,
} from "@chili3d/fabrication/react";
import { Button, Checkbox, Panel } from "@chili3d/react";
import { useEffect, useMemo, useState } from "react";
import style from "./endCapConfigurator.module.css";

function download(name: string, content: Blob | string, type: string) {
    const blob = typeof content === "string" ? new Blob([content], { type }) : content;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The End Cap Configurator as a page: Onshape's configuration panel on the left, the flat
 * pattern in the middle, exports on the right — DXF/SVG of this cap, a zip of every preset (the
 * "End caps — all preset sizes" profile), or the cap opened as a sketch in the CAD workbench.
 * The URL carries the configuration, so a link reopens the same cap.
 */
export function EndCapConfigurator() {
    const [form, setForm] = useState(DEFAULT_END_CAP_FORM);
    const [bendLines, setBendLines] = useState(false);
    const [zipping, setZipping] = useState(false);
    const [zipError, setZipError] = useState<string>();

    useEffect(() => {
        const params = endCapFromSearchParams(new URLSearchParams(window.location.search));
        if (params !== undefined) setForm(endCapFormOf(params));
    }, []);

    const { params, errors } = readEndCapForm(form);
    const pattern = useMemo(() => (params === undefined ? undefined : endCapPattern(params)), [params]);
    const drawing = pattern?.isOk ? toDrawing(pattern.value, { bendLines }) : undefined;
    const name = params === undefined ? undefined : endCapName(params);
    const search = params === undefined ? undefined : endCapSearchParams(params).toString();

    useEffect(() => {
        if (search !== undefined) window.history.replaceState(null, "", `?${search}`);
    }, [search]);

    const exportZip = async () => {
        setZipping(true);
        setZipError(undefined);
        try {
            const zip = await endCapDxfZip(presetEndCaps(), { bendLines });
            if (zip.isOk) download("End Caps.zip", zip.value, "application/zip");
            else setZipError(zip.error);
        } finally {
            setZipping(false);
        }
    };

    return (
        <div className={style.page}>
            <header className={style.header}>
                <span className={style.brand}>Chili3D</span>
                <h1 className={style.title}>End Cap Configurator</h1>
                <span className={style.spacer} />
                <a className={style.note} href="../?template=end-cap-configurator">
                    Open the public template
                </a>
                <a className={style.note} href="../">
                    Open the workbench
                </a>
            </header>
            <main className={style.body}>
                <div className={style.column}>
                    <Panel title="Configurations">
                        <EndCapForm value={form} onChange={setForm} />
                    </Panel>
                    <Panel title="Parts">
                        {pattern?.isOk ? (
                            <table className={style.parts}>
                                <thead>
                                    <tr>
                                        <th>Part</th>
                                        <th>Blank (W × H)</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {pattern.value.parts.map((part) => {
                                        const bounds = drawingBounds(
                                            toDrawing({ ...pattern.value, parts: [part] }),
                                        );
                                        const size = bounds && [
                                            bounds.max[0] - bounds.min[0],
                                            bounds.max[1] - bounds.min[1],
                                        ];
                                        return (
                                            <tr key={part.name}>
                                                <td>{part.name}</td>
                                                <td>
                                                    {size
                                                        ? `${size[0].toFixed(3)} × ${size[1].toFixed(3)} in`
                                                        : ""}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        ) : (
                            <p className={style.note}>Complete the configuration to see the parts.</p>
                        )}
                    </Panel>
                </div>
                <div className={style.previewWrap}>
                    <h2 className={style.capName}>{name ?? "End Cap"}</h2>
                    <EndCapPreview className={style.preview} params={params} error={errors.cap} />
                </div>
                <div className={style.column}>
                    <Panel title="Export">
                        <div className={style.actions}>
                            <Checkbox
                                label="Include bend lines"
                                checked={bendLines}
                                onChange={setBendLines}
                            />
                            <Button
                                variant="primary"
                                disabled={drawing === undefined}
                                onClick={() =>
                                    drawing &&
                                    name &&
                                    download(`${name}.dxf`, writeDxf(drawing), "application/dxf")
                                }
                            >
                                Download DXF
                            </Button>
                            <Button
                                disabled={drawing === undefined}
                                onClick={() =>
                                    drawing &&
                                    name &&
                                    download(
                                        `${name}.svg`,
                                        writeSvg(drawing, { title: name }),
                                        "image/svg+xml",
                                    )
                                }
                            >
                                Download SVG
                            </Button>
                            <Button
                                disabled={search === undefined}
                                onClick={() => window.location.assign(`../?${search}`)}
                            >
                                Open in CAD
                            </Button>
                        </div>
                    </Panel>
                    <Panel title="All preset sizes">
                        <p className={style.note}>
                            Every plain cap and every reducer between the preset sizes (
                            {presetEndCaps().length} DXF files), named like the Onshape exports.
                        </p>
                        <Button onClick={exportZip} disabled={zipping}>
                            {zipping ? "Packing…" : "Download all (.zip)"}
                        </Button>
                        {zipError === undefined ? null : <p className={style.note}>{zipError}</p>}
                    </Panel>
                    <Panel title="Onshape">
                        <p className={style.note}>
                            Configuration of this cap in the End Cap Configurator document:
                        </p>
                        <span className={style.mono}>
                            {params === undefined
                                ? "—"
                                : (onshapeConfiguration(params) ?? "Custom size (no preset configuration)")}
                        </span>
                        {params?.reducing ? (
                            <p className={style.note}>
                                Collar finish wall height{" "}
                                {formatFractionalInches(params.wallHeight ?? defaultWallHeight(params.od))}.
                            </p>
                        ) : null}
                    </Panel>
                </div>
            </main>
        </div>
    );
}
