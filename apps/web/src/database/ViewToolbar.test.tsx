// @vitest-environment jsdom
/** The filter editor reads a saved condition back the way Apply parses it again. */
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ColumnSpec } from "@stuga/protocol/databases/types";
import { mountInto } from "../test/form-input";
import type { ViewShape } from "./model/view-shape";

// A reader whose decimal sign is a comma.
vi.mock("../i18n/i18n", async (importOriginal) => ({ ...(await importOriginal<typeof import("../i18n/i18n")>()), formatLocale: () => "de" }));
const { ViewToolbar } = await import("./ViewToolbar");

const PRICE = { column_id: "c1", name: "price", display: "Price", type: "number" } as unknown as ColumnSpec;
const SHAPE = {
  filter: { column_id: "c1", op: "gt", value: 0.125 },
  sorts: [],
  group_by: null,
  hidden_columns: [],
} as unknown as ViewShape;

const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);

describe("a saved number condition", () => {
  it("keeps 0.125 when Apply is pressed in a comma-decimal language", async () => {
    const onShape = vi.fn();
    const { root } = mountInto();
    await act(async () =>
      root.render(
        <ViewToolbar columns={[PRICE]} search="" onSearch={() => {}} shape={SHAPE} onShape={onShape} dirty={false} hasView readOnly={false} onSave={() => {}} onReset={() => {}} compact={false} />,
      ),
    );
    await act(async () => document.querySelector<HTMLElement>(".db-toolbar__ctl .db-chip")!.click());
    const value = document.querySelector<HTMLInputElement>('input[aria-label="Value"]');
    expect(value?.value).toBe("0,125");
    await act(async () => button("Apply")!.click());
    expect(onShape).toHaveBeenCalledWith(expect.objectContaining({ filter: { column_id: "c1", op: "gt", value: 0.125 } }));
  });
});
