// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ButtonHTMLAttributes,
    type InputHTMLAttributes,
    type ReactNode,
    type SelectHTMLAttributes,
    useId,
} from "react";
import style from "./controls.module.css";

/**
 * Small form controls in the Chili3d look (they read the app's theme variables and fall back
 * to the light theme outside the app). Plain elements underneath, so they stay accessible and
 * work with any form library.
 */

const join = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

export function Panel(props: { title?: ReactNode; children?: ReactNode; className?: string }) {
    return (
        <section className={join(style.panel, props.className)}>
            {props.title === undefined ? null : <h2 className={style.panelTitle}>{props.title}</h2>}
            {props.children}
        </section>
    );
}

export interface FieldProps {
    readonly label: ReactNode;
    readonly hint?: ReactNode;
    readonly error?: ReactNode;
    /** Receives the id to put on the control the label names. */
    readonly children: (id: string) => ReactNode;
}

/** A labelled control with an optional hint and error line. */
export function Field(props: FieldProps) {
    const id = useId();
    return (
        <div className={style.field}>
            <label className={style.fieldLabel} htmlFor={id}>
                {props.label}
            </label>
            {props.children(id)}
            {props.error ? (
                <span className={style.fieldError} role="alert">
                    {props.error}
                </span>
            ) : props.hint ? (
                <span className={style.fieldHint}>{props.hint}</span>
            ) : null}
        </div>
    );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
    readonly label: ReactNode;
    readonly onChange: (checked: boolean) => void;
}

export function Checkbox({ label, onChange, className, ...rest }: CheckboxProps) {
    return (
        <label className={join(style.checkbox, className)}>
            <input {...rest} type="checkbox" onChange={(e) => onChange(e.currentTarget.checked)} />
            {label}
        </label>
    );
}

export interface SelectOption<T extends string> {
    readonly value: T;
    readonly label: ReactNode;
}

export interface SelectProps<T extends string>
    extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange"> {
    readonly value: T;
    readonly options: readonly SelectOption<T>[];
    readonly onChange: (value: T) => void;
}

export function Select<T extends string>({ value, options, onChange, className, ...rest }: SelectProps<T>) {
    return (
        <select
            {...rest}
            className={join(style.select, className)}
            value={value}
            onChange={(e) => onChange(e.currentTarget.value as T)}
        >
            {options.map((option) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
    );
}

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> {
    readonly onChange: (value: string) => void;
    readonly invalid?: boolean;
}

export function TextInput({ onChange, invalid, className, ...rest }: TextInputProps) {
    return (
        <input
            {...rest}
            aria-invalid={invalid || undefined}
            className={join(style.input, invalid && style.invalid, className)}
            onChange={(e) => onChange(e.currentTarget.value)}
        />
    );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    readonly variant?: "primary" | "secondary";
}

export function Button({ variant = "secondary", className, type = "button", ...rest }: ButtonProps) {
    return (
        <button
            {...rest}
            type={type}
            className={join(style.button, variant === "primary" && style.primary, className)}
        />
    );
}

/** The full-window boot screen (the React successor of the old `chili-loading` element). */
export function LoadingScreen(props: { label?: ReactNode }) {
    return (
        <div className={style.loading} role="status" aria-live="polite">
            <div className={style.spinner} />
            <div>{props.label ?? "Loading..."}</div>
        </div>
    );
}
