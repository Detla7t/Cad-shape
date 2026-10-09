// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { arcSweep, type Drawing, type DrawingEntity, drawingBounds, type Point2 } from "@chili3d/drawing";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import style from "./controls.module.css";

/**
 * A `@chili3d/drawing` drawing as inline SVG, fitted to its box: the same model the DXF and
 * SVG writers export, so a preview shows exactly what the file will hold. Strokes keep their
 * pixel width at any zoom; dashed layers are drawn dashed.
 */

export interface DrawingLabel {
    readonly position: Point2;
    readonly text: ReactNode;
}

export interface DrawingViewProps {
    readonly drawing: Drawing;
    /** Space around the drawing, in drawing units (default 4% of the larger side). */
    readonly padding?: number;
    /** Stroke width in pixels. */
    readonly strokeWidth?: number;
    /** Text placed at drawing coordinates, upright. */
    readonly labels?: readonly DrawingLabel[];
    readonly title?: string;
    readonly className?: string;
    readonly style?: CSSProperties;
}

const DEG = Math.PI / 180;

function arcPath(entity: Extract<DrawingEntity, { kind: "arc" }>): string {
    const sweep = arcSweep(entity.startAngle, entity.endAngle);
    const at = (deg: number) =>
        `${entity.center[0] + entity.radius * Math.cos(deg * DEG)} ${entity.center[1] + entity.radius * Math.sin(deg * DEG)}`;
    const r = entity.radius;
    if (sweep >= 360) {
        // A full turn is two half arcs (one SVG arc cannot end where it starts).
        return `M ${at(0)} A ${r} ${r} 0 1 1 ${at(180)} A ${r} ${r} 0 1 1 ${at(360)}`;
    }
    // Drawn inside the y-flip, where counter-clockwise is SVG's positive (sweep-flag 1) direction.
    return `M ${at(entity.startAngle)} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${at(entity.startAngle + sweep)}`;
}

function shape(entity: DrawingEntity, key: number): ReactNode {
    switch (entity.kind) {
        case "line":
            return <line key={key} x1={entity.a[0]} y1={entity.a[1]} x2={entity.b[0]} y2={entity.b[1]} />;
        case "circle":
            return <circle key={key} cx={entity.center[0]} cy={entity.center[1]} r={entity.radius} />;
        case "arc":
            return <path key={key} d={arcPath(entity)} />;
        case "text":
            return null;
    }
}

export function DrawingView(props: DrawingViewProps) {
    const { drawing } = props;
    const bounds = useMemo(() => drawingBounds(drawing), [drawing]);
    const strokeWidth = props.strokeWidth ?? 1.25;
    const className = props.className === undefined ? style.drawing : `${style.drawing} ${props.className}`;
    if (bounds === undefined) {
        return <svg className={className} style={props.style} role="img" aria-label={props.title} />;
    }
    const width = bounds.max[0] - bounds.min[0];
    const height = bounds.max[1] - bounds.min[1];
    const padding = props.padding ?? Math.max(width, height) * 0.04;
    const viewBox = [
        bounds.min[0] - padding,
        -bounds.max[1] - padding,
        width + 2 * padding,
        height + 2 * padding,
    ];
    const fontSize = Math.max(width, height) * 0.025;
    const texts = drawing.entities.filter((e) => e.kind === "text");

    return (
        <svg
            className={className}
            style={props.style}
            viewBox={viewBox.join(" ")}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={props.title}
        >
            {props.title === undefined ? null : <title>{props.title}</title>}
            <g transform="scale(1 -1)" fill="none" strokeLinecap="round" strokeLinejoin="round">
                {drawing.layers.map((layer) => (
                    <g
                        key={layer.name}
                        data-layer={layer.name}
                        stroke={layer.color}
                        strokeWidth={strokeWidth}
                        strokeDasharray={layer.dashed ? `${strokeWidth * 8} ${strokeWidth * 4}` : undefined}
                    >
                        {drawing.entities.map((entity, i) =>
                            entity.layer === layer.name ? shape(entity, i) : null,
                        )}
                    </g>
                ))}
            </g>
            {texts.map((entity, i) =>
                entity.kind === "text" ? (
                    <text
                        // biome-ignore lint/suspicious/noArrayIndexKey: a drawing's entities never reorder; the index is their identity.
                        key={`t${i}`}
                        x={entity.position[0]}
                        y={-entity.position[1]}
                        fontSize={entity.height}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill={drawing.layers.find((l) => l.name === entity.layer)?.color ?? "currentColor"}
                        transform={
                            entity.rotation
                                ? `rotate(${-entity.rotation} ${entity.position[0]} ${-entity.position[1]})`
                                : undefined
                        }
                    >
                        {entity.text}
                    </text>
                ) : null,
            )}
            {props.labels?.map((label, i) => (
                <text
                    // biome-ignore lint/suspicious/noArrayIndexKey: labels are positional, like the drawing's entities.
                    key={`l${i}`}
                    x={label.position[0]}
                    y={-label.position[1]}
                    fontSize={fontSize}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="currentColor"
                >
                    {label.text}
                </text>
            ))}
        </svg>
    );
}
