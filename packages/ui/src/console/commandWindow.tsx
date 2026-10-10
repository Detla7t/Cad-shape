// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IApplication } from "@chili3d/core";
import { mountIsland, type ReactIsland, useApplication } from "@chili3d/react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import style from "./commandWindow.module.css";
import type { ConsoleCommand, ConsoleEngine, ConsoleEntry, ConsoleResultTable } from "./consoleEngine";

/**
 * The command window (AutoCAD's command line): the input line on top, the suggestions with a
 * short explanation and syntax as you type, the full explanation and the preview of the result
 * under it, and the console log beside. Tab accepts a suggestion, ↑↓ move through them (or the
 * history when none is open), Enter runs the line. See `ConsoleEngine` for the commands.
 */

export interface CommandWindowProps {
    readonly engine: ConsoleEngine;
    readonly onClose: () => void;
}

const TABS = ["Console", "History", "Help"] as const;
type Tab = (typeof TABS)[number];

function useHistory(engine: ConsoleEngine): readonly ConsoleEntry[] {
    const subscribe = (notify: () => void) => engine.onChanged(notify);
    const read = () => engine.history;
    return useSyncExternalStore(subscribe, read, read);
}

export function CommandWindow({ engine, onClose }: CommandWindowProps) {
    const [tab, setTab] = useState<Tab>("Console");
    const [input, setInput] = useState("");
    const [selected, setSelected] = useState(0);
    const [recall, setRecall] = useState<number | undefined>();
    const [last, setLast] = useState<(ConsoleEntry & { command?: ConsoleCommand }) | undefined>();
    const history = useHistory(engine);
    const inputRef = useRef<HTMLInputElement>(null);
    const suggestions = useMemo(() => engine.suggest(input), [engine, input]);
    const preview = useMemo(() => engine.preview(input), [engine, input]);
    const typed = engine.find(input.trim().split(/\s+/)[0] ?? "");
    const explained: ConsoleCommand | undefined = suggestions[selected]?.command ?? typed ?? last?.command;
    useEffect(() => setSelected(0), [input]);
    useEffect(() => inputRef.current?.focus(), []);

    const accept = () => {
        const suggestion = suggestions[selected];
        if (suggestion !== undefined) setInput(suggestion.insert);
    };
    const run = async () => {
        if (input.trim() === "") return;
        const entry = await engine.run(input);
        setLast({ ...entry, command: engine.find(input.trim().split(/\s+/)[0] ?? "") });
        setInput("");
        setRecall(undefined);
    };
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        event.stopPropagation();
        if (event.key === "Tab") {
            if (suggestions.length === 0) return;
            event.preventDefault();
            accept();
        } else if (event.key === "Enter") {
            event.preventDefault();
            void run();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            if (suggestions.length > 0) {
                setSelected((at) => (at + delta + suggestions.length) % suggestions.length);
                return;
            }
            if (history.length === 0) return;
            const at = recall === undefined ? (delta < 0 ? history.length - 1 : undefined) : recall + delta;
            if (at === undefined || at < 0 || at >= history.length) {
                setRecall(undefined);
                setInput("");
                return;
            }
            setRecall(at);
            setInput(history[at].input);
        } else if (event.key === "Escape") {
            if (input !== "") setInput("");
            else onClose();
        }
    };

    return (
        <section className={style.root} aria-label="Command window">
            <div className={style.tabs} role="tablist">
                {TABS.map((name) => (
                    <button
                        key={name}
                        type="button"
                        role="tab"
                        aria-selected={tab === name}
                        onClick={() => setTab(name)}
                    >
                        {name}
                    </button>
                ))}
                <button
                    type="button"
                    className={style.close}
                    aria-label="Close command window"
                    onClick={onClose}
                >
                    ×
                </button>
            </div>
            <div className={style.body}>
                <Log entries={history} tab={tab} engine={engine} />
                <div className={style.pane}>
                    <div className={style.inputRow}>
                        <span className={style.prompt} aria-hidden="true">
                            &gt;
                        </span>
                        <input
                            ref={inputRef}
                            role="combobox"
                            aria-label="Command line"
                            aria-autocomplete="list"
                            aria-controls="chili-console-suggestions"
                            aria-expanded={suggestions.length > 0}
                            spellCheck={false}
                            value={input}
                            placeholder="Type a command (HELP) or an expression (2 * 3 in)"
                            onChange={(event) => setInput(event.currentTarget.value)}
                            onKeyDown={onKeyDown}
                        />
                        <span className={style.hints}>
                            <span>
                                <kbd>Tab</kbd> accept
                            </span>
                            <span>
                                <kbd>↑↓</kbd> navigate
                            </span>
                            <span>
                                <kbd>Enter</kbd> run
                            </span>
                        </span>
                    </div>
                    {preview !== undefined ? (
                        <div className={style.preview} data-preview={preview}>
                            {preview}
                        </div>
                    ) : null}
                    {suggestions.length > 0 ? (
                        <div
                            id="chili-console-suggestions"
                            className={style.suggestions}
                            role="listbox"
                            aria-label="Suggestions"
                        >
                            {suggestions.map((suggestion, i) => (
                                <button
                                    key={suggestion.command.name}
                                    type="button"
                                    role="option"
                                    aria-selected={i === selected}
                                    tabIndex={-1}
                                    onPointerDown={(event) => event.preventDefault()}
                                    onClick={() => {
                                        setInput(suggestion.insert);
                                        inputRef.current?.focus();
                                    }}
                                >
                                    <span className={style.name}>
                                        {suggestion.command.name.toUpperCase()}
                                    </span>
                                    <span className={style.about}>
                                        {suggestion.command.syntax} — {suggestion.command.description}
                                    </span>
                                </button>
                            ))}
                        </div>
                    ) : null}
                    <div className={style.details}>
                        <Explanation command={explained} />
                        <Preview entry={last} />
                    </div>
                </div>
            </div>
        </section>
    );
}

function Log({
    entries,
    tab,
    engine,
}: {
    entries: readonly ConsoleEntry[];
    tab: Tab;
    engine: ConsoleEngine;
}) {
    const end = useRef<HTMLDivElement>(null);
    useEffect(() => end.current?.scrollIntoView?.({ block: "end" }), [entries.length]);
    if (tab === "Help") {
        return (
            <section className={style.log} aria-label="Help">
                {engine
                    .commands()
                    .filter((command) => command.kind !== "app")
                    .map((command) => (
                        <div key={command.name}>
                            <span className={style.input}>{command.syntax}</span>
                            <span className={style.output}>{command.description}</span>
                        </div>
                    ))}
                <div>
                    <span className={style.output}>
                        Any tool by its key or name starts it: EXTRUDE, DOC.SAVE…
                    </span>
                </div>
            </section>
        );
    }
    const shown = tab === "History" ? entries.filter((entry) => entry.kind !== "query") : entries;
    return (
        <div className={style.log} role="log" aria-label={tab === "History" ? "History" : "Console log"}>
            {shown.map((entry, i) => (
                <div key={`${i}-${entry.time}`} data-entry={entry.kind}>
                    <span className={style.time}>{entry.time}</span>
                    <span className={style.input}>{entry.input}</span>
                    {entry.result.error !== undefined ? (
                        <span className={style.error}>{entry.result.error}</span>
                    ) : (
                        <span className={style.output}>{entry.result.lines.join(" ")}</span>
                    )}
                </div>
            ))}
            <div ref={end} />
        </div>
    );
}

function Explanation({ command }: { command: ConsoleCommand | undefined }) {
    if (command === undefined) {
        return (
            <div className={style.explanation}>
                <span className={style.empty}>
                    Type a command to see what it does, its syntax and examples. HELP lists them all.
                </span>
            </div>
        );
    }
    return (
        <section className={style.explanation} aria-label={`About ${command.name}`}>
            <h4>{command.name.toUpperCase()}</h4>
            <p>{command.description}</p>
            <h5>Syntax</h5>
            <pre>{command.syntax}</pre>
            {command.arguments?.length ? (
                <>
                    <h5>Arguments</h5>
                    <dl>
                        {command.arguments.map((argument) => (
                            <div key={argument.name} style={{ display: "contents" }}>
                                <dt>{argument.name}</dt>
                                <dd>{argument.description}</dd>
                            </div>
                        ))}
                    </dl>
                </>
            ) : null}
            {command.examples?.length ? (
                <>
                    <h5>Examples</h5>
                    <pre>{command.examples.join("\n")}</pre>
                </>
            ) : null}
        </section>
    );
}

function Preview({ entry }: { entry: (ConsoleEntry & { command?: ConsoleCommand }) | undefined }) {
    if (entry === undefined) {
        return (
            <div className={style.previewPane}>
                <h4>Preview</h4>
                <span className={style.empty}>The result of the last line shows here.</span>
            </div>
        );
    }
    const table: ConsoleResultTable | undefined = entry.result.table;
    return (
        <section className={style.previewPane} aria-label="Preview">
            <h4>
                Preview <span className={style.empty}>{entry.input}</span>
            </h4>
            {entry.result.error !== undefined ? (
                <div className={style.error}>{entry.result.error}</div>
            ) : null}
            {entry.result.lines.map((line, i) => (
                <div key={`${i}-${line}`}>{line}</div>
            ))}
            {table !== undefined ? (
                <table>
                    <thead>
                        <tr>
                            {table.columns.map((column) => (
                                <th key={column}>{column}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {table.rows.map((row, i) => (
                            <tr key={`${i}-${row[0]}`}>
                                {row.map((cell, j) => (
                                    <td key={`${j}-${cell}`}>{cell}</td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : null}
        </section>
    );
}

/** The window for the application, bound to one engine. */
export function CommandWindowIsland({ engine, onClose }: CommandWindowProps) {
    useApplication();
    return <CommandWindow engine={engine} onClose={onClose} />;
}

export function mountCommandWindow(
    host: Element,
    application: IApplication,
    engine: ConsoleEngine,
    onClose: () => void,
): ReactIsland {
    return mountIsland(host, <CommandWindowIsland engine={engine} onClose={onClose} />, application);
}
