// @vitest-environment jsdom
/** Appearance: two labelled choices, each with a hint about that choice alone. */
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mountInto } from "../../test/form-input";

vi.mock("@astryxdesign/core/Toast", () => import("../../test/toast"));

const { Appearance } = await import("./Appearance");

async function open() {
  const { host, root } = mountInto();
  await act(async () => root.render(<Appearance />));
  return host;
}

describe("Appearance", () => {
  it("names each choice on the page, with where it applies", async () => {
    const host = await open();
    const rows = [...host.querySelectorAll("p, span")].map((el) => el.textContent);
    expect(rows).toContain("Theme");
    expect(rows).toContain("Language");
    expect(host.textContent).toContain("Applies to this browser only.");
    expect(host.textContent).toContain("Applies to your account on every device.");
  });
});
