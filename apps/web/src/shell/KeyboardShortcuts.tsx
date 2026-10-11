/**
 * The list of the keyboard shortcuts the app has, opened with ? (outside a text
 * field), ⌘/ or Ctrl+/ anywhere, or from the account menu. Mounted once, above the router.
 */
import { useEffect } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { Kbd } from "@astryxdesign/core/Kbd";
import { createStore, useStore } from "../lib/store";
import { t, type MessageKey } from "../i18n/i18n";

const shortcutsOpen = createStore(false);

export function openKeyboardShortcuts(): void {
  shortcutsOpen.set(true);
}

/** Keys as Kbd spells them: "mod+k", "/", alternatives as separate entries. */
const GROUPS: Array<{ title: MessageKey; rows: Array<{ what: MessageKey; keys: string[] }> }> = [
  {
    title: "shell.shortcuts.everywhere",
    rows: [
      { what: "shell.shortcuts.search", keys: ["mod+k"] },
      { what: "shell.shortcuts.list", keys: ["?", "mod+/"] },
      { what: "shell.shortcuts.close", keys: ["esc"] },
    ],
  },
  {
    title: "shell.shortcuts.library",
    rows: [
      { what: "shell.shortcuts.move", keys: ["up", "down"] },
      { what: "shell.shortcuts.open", keys: ["enter"] },
      { what: "shell.shortcuts.rowMenu", keys: ["shift+f10"] },
    ],
  },
  {
    title: "shell.shortcuts.writing",
    rows: [
      { what: "shell.shortcuts.insert", keys: ["/"] },
      { what: "shell.shortcuts.mention", keys: ["@"] },
      { what: "shell.shortcuts.bold", keys: ["mod+b"] },
      { what: "shell.shortcuts.italic", keys: ["mod+i"] },
      { what: "shell.shortcuts.underline", keys: ["mod+u"] },
      { what: "shell.shortcuts.undo", keys: ["mod+z"] },
      { what: "shell.shortcuts.redo", keys: ["mod+shift+z"] },
    ],
  },
];

/** Where a typed ? is text, not a request for this list. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

export function KeyboardShortcuts() {
  const isOpen = useStore(shortcutsOpen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A key something else already handled, such as an editor's own shortcut, is not ours.
      if (e.defaultPrevented || e.isComposing || e.altKey) return;
      const modSlash = (e.metaKey || e.ctrlKey) && e.key === "/";
      const question = e.key === "?" && !e.metaKey && !e.ctrlKey && !isTyping(e.target);
      if (!modSlash && !question) return;
      e.preventDefault();
      shortcutsOpen.update((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => shortcutsOpen.set(open)} purpose="info" width={480}>
      <Layout
        header={<DialogHeader title={t("shell.shortcuts.title")} onOpenChange={(open) => shortcutsOpen.set(open)} />}
        content={
          <LayoutContent>
            <VStack gap={5}>
              {GROUPS.map((group) => (
                <VStack gap={2} key={group.title}>
                  <Heading level={3}>{t(group.title)}</Heading>
                  <dl className="shortcut-list">
                    {group.rows.map((row) => (
                      <div className="shortcut-row" key={row.what}>
                        <dt>
                          <Text>{t(row.what)}</Text>
                        </dt>
                        <dd>
                          {row.keys.map((keys) => (
                            <Kbd key={keys} keys={keys} />
                          ))}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </VStack>
              ))}
            </VStack>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
