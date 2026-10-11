// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { InboxRun } from "../api";
import { mountInto } from "../test/form-input";

const inbox = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), Inbox: inbox }));

const { ReviewQueueProvider, useReviewQueue } = await import("./review-queue");

const run = (doc_id: string, pending: number) => ({ run_id: `r_${doc_id}`, doc_id, pending }) as unknown as InboxRun;

let root: Root;
let seen: ReturnType<typeof useReviewQueue> = null;

function Probe() {
  seen = useReviewQueue();
  return null;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  seen = null;
  ({ root } = mountInto());
});

describe("ReviewQueueProvider", () => {
  it("counts what waits for this person and marks the items with edits waiting", async () => {
    inbox.list.mockResolvedValue({ runs: [run("d1", 2), run("d2", 0)], filter: "attention" });
    await act(async () => root.render(<ReviewQueueProvider><Probe /></ReviewQueueProvider>));
    await settle();

    expect(inbox.list).toHaveBeenCalledWith("attention");
    expect(seen).toMatchObject({ count: 2, capped: false });
    // An applied run asks for a look, not a decision: its item carries no mark.
    expect([...seen!.waiting]).toEqual(["d1"]);
  });

  it("reads again when the tab comes back, and keeps what it showed when a read fails", async () => {
    inbox.list.mockResolvedValueOnce({ runs: [run("d1", 1)], filter: "attention" });
    await act(async () => root.render(<ReviewQueueProvider><Probe /></ReviewQueueProvider>));
    await settle();
    expect(seen?.count).toBe(1);

    inbox.list.mockRejectedValueOnce(new Error("offline"));
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(inbox.list).toHaveBeenCalledTimes(2);
    expect(seen?.count).toBe(1);

    inbox.list.mockResolvedValueOnce({ runs: [], filter: "attention" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(seen?.count).toBe(0);
  });
});
