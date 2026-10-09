// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Checkbox, DrawingView, Field, Select, TextInput } from "@chili3d/react";
import { useMemo, useState } from "react";
import { type EndCapParams, endCapPattern } from "../endcap/endCap";
import { formatFractionalInches, parseInches } from "../endcap/inches";
import { defaultWallHeight } from "../endcap/sizes";
import { toDrawing } from "../geometry/toDrawing";
import style from "./endCap.module.css";
import { CUSTOM_SIZE, type EndCapFormValue, readEndCapForm, SIZE_OPTIONS } from "./endCapForm";

/**
 * The End Cap configuration panel, shared by the configurator page (`/endcap`) and the
 * workbench's End Cap dialog. Controlled: the owner keeps the value.
 */
export function EndCapForm(props: { value: EndCapFormValue; onChange: (value: EndCapFormValue) => void }) {
    const { value, onChange } = props;
    const { errors } = readEndCapForm(value);
    const set = (patch: Partial<EndCapFormValue>) => onChange({ ...value, ...patch });
    const od = value.od === CUSTOM_SIZE ? parseInches(value.customOd) : Number(value.od);
    const autoWall = od === undefined ? undefined : formatFractionalInches(defaultWallHeight(od));

    return (
        <div className={style.form}>
            <Checkbox label="Endcap" checked={value.endcap} onChange={(endcap) => set({ endcap })} />
            <Field label="OD" error={errors.od}>
                {(id) => (
                    <Select id={id} value={value.od} options={SIZE_OPTIONS} onChange={(od) => set({ od })} />
                )}
            </Field>
            {value.od === CUSTOM_SIZE ? (
                <Field label="Custom OD" error={errors.od}>
                    {(id) => (
                        <TextInput
                            id={id}
                            value={value.customOd}
                            invalid={errors.od !== undefined}
                            onChange={(customOd) => set({ customOd })}
                        />
                    )}
                </Field>
            ) : null}
            {value.endcap ? null : (
                <>
                    <Field label="ID" error={value.id === CUSTOM_SIZE ? undefined : errors.id}>
                        {(id) => (
                            <Select
                                id={id}
                                value={value.id}
                                options={SIZE_OPTIONS}
                                onChange={(next) => set({ id: next })}
                            />
                        )}
                    </Field>
                    {value.id === CUSTOM_SIZE ? (
                        <Field label="Custom ID" error={errors.id}>
                            {(id) => (
                                <TextInput
                                    id={id}
                                    value={value.customId}
                                    invalid={errors.id !== undefined}
                                    onChange={(customId) => set({ customId })}
                                />
                            )}
                        </Field>
                    ) : null}
                    <Checkbox
                        label="Wall Height"
                        checked={value.customWallHeight}
                        onChange={(customWallHeight) =>
                            set({
                                customWallHeight,
                                wallHeight: customWallHeight
                                    ? (autoWall ?? value.wallHeight)
                                    : value.wallHeight,
                            })
                        }
                    />
                    {value.customWallHeight ? (
                        <Field label="Finish Wall Height" error={errors.wallHeight}>
                            {(id) => (
                                <TextInput
                                    id={id}
                                    value={value.wallHeight}
                                    invalid={errors.wallHeight !== undefined}
                                    onChange={(wallHeight) => set({ wallHeight })}
                                />
                            )}
                        </Field>
                    ) : (
                        <span className={style.indent}>
                            {autoWall === undefined ? null : `Finish wall height ${autoWall}`}
                        </span>
                    )}
                </>
            )}
        </div>
    );
}

/** The flat pattern of `params` as it will be cut (the DXF's geometry, bend lines dashed). */
export function EndCapPreview(props: { params?: EndCapParams; error?: string; className?: string }) {
    const { params } = props;
    const pattern = useMemo(() => (params === undefined ? undefined : endCapPattern(params)), [params]);
    const error = props.error ?? (pattern !== undefined && !pattern.isOk ? pattern.error : undefined);
    const drawing = pattern?.isOk ? toDrawing(pattern.value, { bendLines: true }) : undefined;
    return (
        <div
            className={props.className === undefined ? style.preview : `${style.preview} ${props.className}`}
        >
            {drawing !== undefined && pattern?.isOk ? (
                <DrawingView drawing={drawing} title={pattern.value.name} />
            ) : null}
            {error === undefined ? null : <div className={style.error}>{error}</div>}
        </div>
    );
}

/**
 * Form and preview side by side, keeping its own state from `initial` — the content of the
 * workbench's End Cap dialog. `onChange` reports every edit to the dialog's owner.
 */
export function EndCapEditor(props: {
    initial: EndCapFormValue;
    onChange?: (value: EndCapFormValue) => void;
}) {
    const [value, setValue] = useState(props.initial);
    const result = readEndCapForm(value);
    return (
        <div className={style.dialog}>
            <EndCapForm
                value={value}
                onChange={(next) => {
                    setValue(next);
                    props.onChange?.(next);
                }}
            />
            <EndCapPreview params={result.params} error={result.errors.cap} />
        </div>
    );
}
