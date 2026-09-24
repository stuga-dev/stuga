/**
 * Typed wrapper for `markdown-it-footnote`, which ships no types. Its
 * DefinitelyTyped package drags in `@types/markdown-it`, whose types conflict
 * with markdown-it v15's own; a real module (not an ambient .d.ts) keeps the
 * typing visible to every package compiling this one from source.
 */
import type { MarkdownIt } from "markdown-it";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error - no bundled types; the cast below is the whole point of this file.
import untypedFootnotePlugin from "markdown-it-footnote";

/** The footnote plugin, typed against markdown-it v15's own instance type. */
export const footnotePlugin = untypedFootnotePlugin as (md: MarkdownIt) => void;
