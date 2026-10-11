// @vitest-environment jsdom
/** A run's toasts carry an Undo for the page they were raised on, so they leave with it. */
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { RunNotices } from "./RunBanner";
import type { RunNotice } from "./use-run-ledger";
import { mountInto } from "../test/form-input";

const raised = vi.hoisted(() => ({ shown: [] as Array<{ uniqueID?: string }>, dismissed: [] as string[] }));

vi.mock("@astryxdesign/core/Toast", () => ({
  useToast: () => (options: { uniqueID?: string }) => {
    raised.shown.push(options);
    return () => raised.dismissed.push(options.uniqueID ?? "");
  },
}));

describe("RunNotices", () => {
  it("takes a run's Undo toast away when the page goes", async () => {
    const notices: RunNotice[] = [{ id: 1, kind: "decided", message: "Rejected 1 change.", runId: "r1", itemIds: ["h1"] }];
    const { root } = mountInto();
    await act(async () =>
      root.render(<RunNotices notices={notices} dismissNotice={() => {}} onUndoDecision={async () => {}} />),
    );
    expect(raised.shown.map((o) => o.uniqueID)).toEqual(["run-decision:r1"]);
    expect(raised.dismissed).toEqual([]);

    await act(async () => root.render(<></>));
    expect(raised.dismissed).toEqual(["run-decision:r1"]);
  });
});
