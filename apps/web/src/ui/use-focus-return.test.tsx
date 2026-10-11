// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { mountInto } from "../test/form-input";
import { useFocusReturn } from "./use-focus-return";

function Opened() {
  useFocusReturn();
  return <input aria-label="inside" autoFocus />;
}

describe("useFocusReturn", () => {
  it("gives focus back to what had it when the component came, once it goes", async () => {
    const trigger = document.body.appendChild(document.createElement("button"));
    trigger.focus();
    const { root } = mountInto();
    await act(async () => root.render(<Opened />));
    expect(document.activeElement).not.toBe(trigger);
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("leaves focus where it is when it did not go with the component", async () => {
    const trigger = document.body.appendChild(document.createElement("button"));
    const elsewhere = document.body.appendChild(document.createElement("button"));
    trigger.focus();
    const { root } = mountInto();
    await act(async () => root.render(<Opened />));
    elsewhere.focus();
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(elsewhere);
    trigger.remove();
    elsewhere.remove();
  });
});
