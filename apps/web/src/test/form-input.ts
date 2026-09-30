/** Mounting a component and driving its form controls from a jsdom test, as a person's input fires their events. For tests only. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, onTestFinished } from "vitest";

/**
 * A React root on a fresh element in the document, unmounted and removed once the test finishes
 * (after its afterEach hooks). Call it from the test or a beforeEach.
 */
export function mountInto(): { host: HTMLDivElement; root: Root } {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  onTestFinished(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, root };
}

/** Set a field's value through the native setter, which React's change tracking needs, and fire `input`. */
export async function typeInto(field: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string): Promise<void> {
  expect(field, "no field to type into").toBeTruthy();
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(field, value);
    field!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Pick the radio option `label` names; Astryx labels each radio by an element beside it. */
export async function chooseRadio(container: ParentNode, label: string): Promise<void> {
  const radio = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
    (r) => document.getElementById(r.getAttribute("aria-labelledby") ?? "")?.textContent === label,
  );
  expect(radio, `no option ${label}`).toBeDefined();
  await act(async () => radio!.click());
}

/** Pick the segment `label` names in a SegmentedControl, whose segments are buttons with the radio role. */
export async function chooseSegment(container: ParentNode, label: string): Promise<void> {
  const segment = [...container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find((b) => b.textContent === label);
  expect(segment, `no segment ${label}`).toBeDefined();
  await act(async () => segment!.click());
}

/** Choose `file` in the one file picker under `container`. */
export async function pickFile(container: ParentNode, file: File): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input, "no file picker").not.toBeNull();
  Object.defineProperty(input!, "files", { value: [file], configurable: true });
  await act(async () => input!.dispatchEvent(new Event("change", { bubbles: true })));
}

/** The trigger of the dropdown whose label starts with `label`; its text names what is chosen. */
export function dropdown(container: ParentNode, label: string): HTMLElement {
  const labelEl = [...container.querySelectorAll("label")].find((l) => l.textContent?.startsWith(label));
  expect(labelEl, `no dropdown ${label}`).toBeDefined();
  return document.getElementById(labelEl!.htmlFor)!;
}

/** Toggle each option named in the dropdown whose label starts with `label`, then close it. */
export async function toggleOptions(container: ParentNode, label: string, ...options: string[]): Promise<void> {
  const trigger = dropdown(container, label);
  const click = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await click(trigger);
  const listbox = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  for (const option of options) {
    const row = [...listbox.querySelectorAll('[role="option"]')].find((o) => o.textContent === option);
    expect(row, `no option ${option}`).toBeDefined();
    await click(row!);
  }
  await click(trigger);
}
