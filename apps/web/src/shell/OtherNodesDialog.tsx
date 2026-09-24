/**
 * The switcher's "Add or remove nodes…": a person's bookmarks to other Stuga
 * nodes. A bookmark is only an address; opening one leaves for that node and
 * its own sign-in. The list comes from the switcher, which re-reads it after
 * every change made here.
 */
import { useEffect, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { X } from "lucide-react";
import { MAX_NODE_LABEL_CHARS, MAX_OTHER_NODES } from "@stuga/protocol/api/other-nodes";
import { OtherNodes, type OtherNode } from "../api";
import { errorMessage, type ApiError } from "../lib/http/client";
import { plainTextProblem } from "../lib/plain-text";

interface OtherNodesDialogProps {
  isOpen: boolean;
  nodes: OtherNode[];
  onClose: () => void;
}

/** Which field a refusal belongs under, and what it says there. */
function refusal(e: unknown): { field: "label" | "url"; message: string } {
  switch ((e as ApiError).code) {
    case "invalid_url":
      return { field: "url", message: "Enter the full address, starting with https:// or http://." };
    case "own_node":
      return { field: "url", message: "That’s this node’s own address." };
    case "already_added":
      return { field: "url", message: "That node is already in your list." };
    case "limit_reached":
      return { field: "url", message: `You can keep up to ${MAX_OTHER_NODES} nodes here. Remove one first.` };
    case "invalid_label":
      return { field: "label", message: `Use up to ${MAX_NODE_LABEL_CHARS} characters, at least one of them visible, and no control characters.` };
    default:
      return { field: "url", message: errorMessage(e, "Couldn’t add that node.") };
  }
}

export function OtherNodesDialog({ isOpen, nodes, onClose }: OtherNodesDialogProps) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [problem, setProblem] = useState<{ field: "label" | "url"; message: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const toast = useToast();

  // The dialog stays mounted between openings, so each opening starts from an empty form.
  useEffect(() => {
    if (!isOpen) return;
    setLabel("");
    setUrl("");
    setProblem(null);
  }, [isOpen]);

  /** An empty label is the host's to fill in; anything typed is checked as it is typed. */
  const labelProblem = label.trim() ? plainTextProblem(label.trim(), MAX_NODE_LABEL_CHARS) : null;

  async function add() {
    if (!url.trim() || labelProblem || adding) return;
    setAdding(true);
    setProblem(null);
    try {
      await OtherNodes.add(url.trim(), label.trim());
      setLabel("");
      setUrl("");
    } catch (e) {
      setProblem(refusal(e));
    } finally {
      setAdding(false);
    }
  }

  async function remove(node: OtherNode) {
    setRemoving(node.id);
    try {
      await OtherNodes.remove(node.id);
    } catch (e) {
      toast({ body: errorMessage(e, `Couldn’t remove ${node.label}.`), type: "error" });
    } finally {
      setRemoving(null);
    }
  }

  // A refusal speaks to what was sent, so it goes once the person edits.
  function edit(set: (value: string) => void, value: string) {
    set(value);
    setProblem(null);
  }

  // Nothing closes the dialog while an add is in flight.
  const close = () => !adding && onClose();

  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && close()} purpose="form" width={440}>
      <Layout
        header={<DialogHeader title="Other nodes" onOpenChange={(o) => !o && close()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <Text color="secondary">Shortcuts to other Stuga nodes. Each has its own sign-in.</Text>
              {nodes.length > 0 && (
                <List hasDividers density="compact">
                  {nodes.map((node) => (
                    <ListItem
                      key={node.id}
                      label={node.label}
                      description={node.origin}
                      endContent={
                        <IconButton
                          label={`Remove ${node.label}`}
                          variant="ghost"
                          size="sm"
                          icon={<X size={15} />}
                          isLoading={removing === node.id}
                          onClick={() => void remove(node)}
                        />
                      }
                    />
                  ))}
                </List>
              )}
              {nodes.length > 0 && <Divider />}
              <VStack gap={3}>
                <TextInput
                  label="Label"
                  isOptional
                  width="100%"
                  value={label}
                  onChange={(v) => edit(setLabel, v)}
                  onEnter={() => void add()}
                  status={
                    labelProblem
                      ? { type: "error", message: labelProblem }
                      : problem?.field === "label"
                        ? { type: "error", message: problem.message }
                        : undefined
                  }
                />
                <TextInput
                  label="URL"
                  width="100%"
                  placeholder="https://…"
                  autoComplete="url"
                  value={url}
                  onChange={(v) => edit(setUrl, v)}
                  onEnter={() => void add()}
                  status={problem?.field === "url" ? { type: "error", message: problem.message } : undefined}
                />
              </VStack>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label="Done" variant="ghost" isDisabled={adding} onClick={close} />
              <Button
                label="Add"
                variant="primary"
                isDisabled={!url.trim() || labelProblem !== null}
                isLoading={adding}
                onClick={() => void add()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
