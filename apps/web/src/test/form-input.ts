/** Driving Astryx form controls from a jsdom test, as a person's input fires their events. For tests only. */
import { act } from "react";
import { expect } from "vitest";

/** Pick the radio option `label` names; Astryx labels each radio by an element beside it. */
export async function chooseRadio(container: ParentNode, label: string): Promise<void> {
  const radio = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
    (r) => document.getElementById(r.getAttribute("aria-labelledby") ?? "")?.textContent === label,
  );
  expect(radio, `no option ${label}`).toBeDefined();
  await act(async () => radio!.click());
}

/** Choose `file` in the one file picker under `container`. */
export async function pickFile(container: ParentNode, file: File): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input, "no file picker").not.toBeNull();
  Object.defineProperty(input!, "files", { value: [file], configurable: true });
  await act(async () => input!.dispatchEvent(new Event("change", { bubbles: true })));
}
