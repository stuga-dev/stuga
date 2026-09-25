// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DatabaseOpSummary } from "@stuga/protocol/databases/types";
import type { UserInfo } from "../api";

const databases = vi.hoisted(() => ({ ops: vi.fn(), revertOp: vi.fn() }));
const users = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock("../api", () => ({ Databases: databases, Users: users }));
vi.mock("@astryxdesign/core/Toast", () => ({ useToast: () => () => {} }));

const { ActivityPanel } = await import("./ActivityPanel");

function op(seq: number, over: Partial<DatabaseOpSummary> = {}): DatabaseOpSummary {
  return {
    op_id: `op_${seq}`,
    seq,
    ts: Date.UTC(2026, 8, 25, 9, seq),
    actor: "alice",
    is_agent: false,
    on_behalf_of: null,
    kind: "rows.update",
    table_id: "t1",
    summary: `Change ${seq}`,
    reverted_by: null,
    reverts: null,
    revertible: true,
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  databases.ops.mockReset();
  users.resolve.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function mount(ops: DatabaseOpSummary[]) {
  databases.ops.mockResolvedValue({ ops });
  await act(async () => {
    root = createRoot(host);
    root.render(<ActivityPanel docId="d_1" refreshKey={0} readOnly={false} onReverted={() => {}} onWriteDenied={() => {}} />);
  });
}

/** Who made each op, newest first. */
const actors = () => [...host.querySelectorAll(".db-op__actor strong")].map((s) => s.textContent);
/** The person each agent op was for, newest first. */
const fors = () => [...host.querySelectorAll(".db-op__for")].map((s) => s.textContent);

// The name cache lives for the file, so each case names its own people.
describe("ActivityPanel: who made a change", () => {
  it("falls back to the short id once the lookup fails", async () => {
    users.resolve.mockRejectedValue(new Error("offline"));
    await mount([
      op(2, { actor: "agent:ci", is_agent: true, on_behalf_of: "u_Wq7L0unreachable" }),
      op(1, { actor: "u_Kcjz0unreachable" }),
    ]);

    expect(users.resolve).toHaveBeenCalledTimes(1);
    expect(actors()).toEqual(["ci", "u_Kcjz…"]);
    expect(fors()).toEqual(["for u_Wq7L…"]);
  });

  it("shows no raw id while names load, then the names", async () => {
    const ada: UserInfo = { alias: "u_QH52ada7RzkP4mXe", username: "ada", display_name: "Ada", email: null };
    const bob: UserInfo = { alias: "u_Bb81bob4TqeW9nJs", username: "bob", display_name: "Bob", email: null };
    let answer!: (r: { users: UserInfo[] }) => void;
    users.resolve.mockReturnValue(new Promise((r) => (answer = r)));
    await mount([
      op(3, { actor: "panel:u_Bb81bob4TqeW9nJs", is_agent: true, on_behalf_of: bob.alias }),
      op(2, { actor: "agent:ci", is_agent: true, on_behalf_of: ada.alias }),
      op(1, { actor: ada.alias }),
    ]);

    // Agents are not looked up, and are named at once.
    expect(users.resolve).toHaveBeenCalledWith([bob.alias, ada.alias]);
    // Blanks that keep each row's height, and Revert in place.
    expect(actors()).toEqual(["AI co-author", "ci", " "]);
    expect(fors()).toEqual([" ", " "]);
    expect(host.querySelectorAll(".db-op__foot button")).toHaveLength(3);
    expect(host.textContent).not.toMatch(/u_QH52|u_Bb81/);

    await act(async () => answer({ users: [ada, bob] }));
    expect(actors()).toEqual(["AI co-author", "ci", "Ada"]);
    expect(fors()).toEqual(["for Bob", "for Ada"]);
  });
});
