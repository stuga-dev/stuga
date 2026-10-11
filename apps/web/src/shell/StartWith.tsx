/**
 * What a new workspace starts with, wherever one is created: nothing, a published sample, or the
 * contents of a file: a workspace archive, or a Notion export or folder of Markdown the node
 * converts into one, which the person confirms first when it leaves files out. Each source is one
 * segment of the control and one case of `createWorkspaceFrom`, so another source joins as one
 * more of each; a sample or a file is then chosen below the control.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { FileInput } from "@astryxdesign/core/FileInput";
import { List, ListItem } from "@astryxdesign/core/List";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { WORKSPACE_IMPORT_MAX_BYTES, type DocAccessMode } from "@stuga/protocol/domain/workspaces";
import { Workspaces, type CreatedWorkspace, type HeldImport, type LeftOut, type LeftOutReason, type WorkspaceSample, type WorkspaceSamples } from "../api";
import type { ApiError } from "../lib/http/client";
import { fileSize } from "../lib/format";
import { t } from "../i18n/i18n";

export type StartChoice =
  | { kind: "empty" }
  | { kind: "sample"; sample: WorkspaceSample | null }
  | { kind: "file"; file: File | null };

/** The samples as the list offers them: `loading` until the node has answered. */
export interface SampleChoices extends WorkspaceSamples {
  loading?: boolean;
}

const EMPTY: StartChoice = { kind: "empty" };
const LOADING: SampleChoices = { samples: [], loading: true };

/** What the name field says while it is empty for a file: the node takes the name the file carries. */
export const ARCHIVE_NAME_PLACEHOLDER = t("shell.startWith.namePlaceholder");

/** The files an import would leave out, as the confirmation's banner says them. */
export function leftOutTitle({ count }: LeftOut): string {
  return t("shell.startWith.leftOutTitle", { count });
}

/**
 * An import the browser, or a proxy in between, stopped waiting for: the node goes on with it, and
 * the workspace is listed once it is done. Worded for a page that lists the workspaces.
 */
export class ImportMayFinish extends Error {
  constructor() {
    super(t("shell.startWith.mayFinish"));
  }
}

/** What asking for a workspace gives: the workspace, or a file the node holds until the person accepts what it leaves out. */
export type Creation = { workspace: CreatedWorkspace } | { held: HeldImport };

/**
 * Create the workspace `start` asks for; the caller becomes its owner. A file is checked first:
 * one that leaves nothing out is imported at once, and one that does is held for importHeldFile.
 * From a file, an empty `name` takes the file's.
 */
export async function createWorkspaceFrom(start: StartChoice, name: string, access: DocAccessMode): Promise<Creation> {
  if (start.kind === "sample" && start.sample) {
    const { id } = start.sample;
    return { workspace: await imported(() => Workspaces.createFromSample(id, name, access)) };
  }
  if (start.kind !== "file" || !start.file) return { workspace: await Workspaces.create(name, access) };
  let held: HeldImport;
  try {
    held = await Workspaces.checkImport(start.file);
  } catch (err) {
    const { status, code } = err as ApiError;
    // The node says how large a file it takes; a 413 without a word of its own is a proxy's in front of it.
    if (status === 413 && !code) throw new Error(t("shell.startWith.tooLargeForProxy"));
    throw err;
  }
  return held.left_out ? { held } : { workspace: await importHeldFile(held, name, access) };
}

/** Import a file the node holds, once the person has seen what it leaves out. */
export function importHeldFile(held: HeldImport, name: string, access: DocAccessMode): Promise<CreatedWorkspace> {
  return imported(() => Workspaces.importHeld(held.import_id, name, access));
}

/** An import's answer, with one the client stopped waiting for said as one that may still finish. */
async function imported(run: () => Promise<CreatedWorkspace>): Promise<CreatedWorkspace> {
  try {
    return await run();
  } catch (err) {
    const { status, code } = err as ApiError;
    if (code === "timeout" || status === 504) throw new ImportMayFinish();
    throw err;
  }
}

/** Why a file is left out, in a few words. */
export function leftOutReason(left: LeftOutReason): string {
  switch (left.reason) {
    case "too_large":
      return t("shell.startWith.reason.tooLarge", { size: fileSize(left.size), limit: fileSize(left.limit) });
    case "unreadable_image":
      return t("shell.startWith.reason.unreadableImage");
    case "unreadable_text":
      return t("shell.startWith.reason.unreadableText");
    case "not_linked":
      return t("shell.startWith.reason.notLinked");
    case "not_kept":
      return t("shell.startWith.reason.notKept");
  }
}

/** The files an import leaves out, by path, each with why, in a list that scrolls when it is long; `title` heads it. */
export function LeftOutList({ leftOut, title = leftOutTitle(leftOut) }: { leftOut: LeftOut; title?: string }) {
  const more = leftOut.count - leftOut.files.length;
  const list = (
    <List density="compact">
      {leftOut.files.map((file) => (
        <ListItem key={file.path} label={file.path} description={leftOutReason(file)} />
      ))}
      {more > 0 && <ListItem label={t("shell.startWith.leftOutMore", { count: more })} />}
    </List>
  );
  return (
    <VStack gap={2}>
      <Banner status="warning" title={title} />
      {leftOut.files.length > 6 ? (
        <ScrollableArea label={t("shell.startWith.leftOutList")} height={260}>
          {list}
        </ScrollableArea>
      ) : (
        list
      )}
    </VStack>
  );
}

/**
 * A ref for a banner heading a create form, brought into view whenever `shown` is set anew, such
 * as an error or the time an import was asked for: the form scrolls, and the banner heads it, far
 * above the file picker and the button.
 */
export function useBannerInView(shown: string | number | boolean | null): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shown !== null && shown !== false) ref.current?.scrollIntoView({ block: "nearest" });
  }, [shown]);
  return ref;
}

/** Where a new workspace opens: the document its archive or sample starts with, else the library. */
export function landingPath(workspace: CreatedWorkspace): string {
  return workspace.start_doc_id ? `/doc/${encodeURIComponent(workspace.start_doc_id)}` : "/";
}

/** How often, while open, a list the node could not offer is asked for again. */
export const SAMPLES_RECHECK_MS = 60_000;

/**
 * The samples a new workspace can start from, asked for whenever `isOpen` turns true; the client
 * keeps the list a minute. Loading until the node answers, and empty when it cannot offer any.
 * One the node could not offer, as offline, is asked for again while open: every
 * SAMPLES_RECHECK_MS, and when the browser comes back online or to the page.
 */
export function useWorkspaceSamples(isOpen: boolean): SampleChoices {
  const [list, setList] = useState<SampleChoices>(() => Workspaces.cachedSamples() ?? LOADING);
  useEffect(() => {
    if (!isOpen) return;
    // What an earlier opening showed may be gone by now.
    setList(Workspaces.cachedSamples() ?? LOADING);
    let live = true;
    Workspaces.samples().then(
      (next) => live && setList(next),
      () => live && setList({ samples: [], unavailable: true }),
    );
    return () => {
      live = false;
    };
  }, [isOpen]);

  const unavailable = isOpen && list.unavailable === true;
  useEffect(() => {
    if (!unavailable) return;
    let live = true;
    const again = () => {
      Workspaces.samplesAgain().then(
        (next) => live && setList(next),
        () => {},
      );
    };
    const timer = setInterval(again, SAMPLES_RECHECK_MS);
    window.addEventListener("online", again);
    window.addEventListener("focus", again);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("online", again);
      window.removeEventListener("focus", again);
    };
  }, [unavailable]);
  return list;
}

/**
 * The name and start of a workspace being created. Unless the person typed a name of their own,
 * the name follows the choice: a sample's own, else none. An archive carries its workspace's name,
 * so from a file the name is optional (`nameOptional`), and left empty the node takes that one.
 */
export function useNewWorkspace() {
  const [name, setNameValue] = useState("");
  const [start, setStartValue] = useState<StartChoice>(EMPTY);
  const typed = useRef(false);
  const setName = useCallback((value: string) => {
    typed.current = value.trim() !== "";
    setNameValue(value);
  }, []);
  const setStart = useCallback((next: StartChoice) => {
    setStartValue(next);
    if (!typed.current) setNameValue(next.kind === "sample" ? (next.sample?.name ?? "") : "");
  }, []);
  const reset = useCallback(() => {
    typed.current = false;
    setNameValue("");
    setStartValue(EMPTY);
  }, []);
  const nameOptional = start.kind === "file";
  const ready = start.kind === "file" ? start.file !== null : (start.kind === "empty" || start.sample !== null) && name.trim() !== "";
  return { name, setName, start, setStart, reset, ready, nameOptional };
}

interface StartWithProps {
  value: StartChoice;
  onChange: (next: StartChoice) => void;
  /** From useWorkspaceSamples. */
  samples: SampleChoices;
  isDisabled?: boolean;
}

/** A segment's start as first chosen: a sample picks the first one offered. */
function startOf(kind: StartChoice["kind"], offered: WorkspaceSample[]): StartChoice {
  if (kind === "sample") return { kind, sample: offered[0] ?? null };
  return kind === "file" ? { kind, file: null } : EMPTY;
}

/** Why no sample can be chosen yet. */
function noSamples({ loading, unavailable }: SampleChoices): string {
  if (loading) return t("shell.startWith.loadingSamples");
  return unavailable ? t("shell.startWith.samplesOffline") : t("shell.startWith.noSamples");
}

export function StartWith({ value, onChange, samples, isDisabled = false }: StartWithProps) {
  // A sample the latest list no longer offers cannot be created from.
  const chosen = value.kind === "sample" ? value.sample : null;
  const offered = !chosen || samples.samples.some((s) => s.id === chosen.id);
  useEffect(() => {
    if (!offered) onChange({ kind: "sample", sample: null });
  }, [offered, onChange]);
  return (
    <VStack gap={3}>
      <SegmentedControl
        label={t("shell.startWith.label")}
        layout="fill"
        value={value.kind}
        isDisabled={isDisabled}
        onChange={(kind) => kind !== value.kind && onChange(startOf(kind as StartChoice["kind"], samples.samples))}
      >
        <SegmentedControlItem value="empty" label={t("shell.startWith.empty")} />
        <SegmentedControlItem value="sample" label={t("shell.startWith.sample")} />
        <SegmentedControlItem value="file" label={t("common.import")} />
      </SegmentedControl>
      {value.kind === "sample" &&
        (samples.samples.length === 0 ? (
          <Text color="secondary">{noSamples(samples)}</Text>
        ) : (
          <RadioList
            label={t("shell.startWith.sample")}
            isLabelHidden
            value={chosen?.id ?? ""}
            isDisabled={isDisabled}
            onChange={(id) => {
              const sample = samples.samples.find((s) => s.id === id);
              if (sample && sample.id !== chosen?.id) onChange({ kind: "sample", sample });
            }}
          >
            {samples.samples.map((s) => (
              <RadioListItem key={s.id} value={s.id} label={s.title} description={s.description} />
            ))}
          </RadioList>
        ))}
      {value.kind === "file" && (
        <FileInput
          label={t("shell.startWith.file")}
          isLabelHidden
          placeholder={t("shell.startWith.filePlaceholder")}
          mode="dropzone"
          accept=".zip,application/zip"
          maxSize={WORKSPACE_IMPORT_MAX_BYTES}
          value={value.file}
          isDisabled={isDisabled}
          onChange={(file) => onChange({ kind: "file", file: Array.isArray(file) ? (file[0] ?? null) : file })}
        />
      )}
    </VStack>
  );
}
