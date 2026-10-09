// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { DatabaseOpSummary } from "@stuga/protocol/databases/types";
import type { UserInfo } from "../api";
import { mountInto } from "../test/form-input";

const databases = vi.hoisted(() => ({ ops: vi.fn(), revertOp: vi.fn() }));
const users = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock("../api", () => ({ Databases: databases, Users: users }));
vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));

const { ActivityPanel } = await import("./ActivityPanel");
const { loadUiLanguage } = await import("../i18n/i18n");

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
    detail: null,
    reverted_by: null,
    reverts: null,
    revertible: true,
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  databases.ops.mockReset();
  users.resolve.mockReset();
});

async function mount(ops: DatabaseOpSummary[]) {
  databases.ops.mockResolvedValue({ ops });
  ({ host, root } = mountInto());
  await act(async () => {
    root.render(<ActivityPanel docId="d_1" refreshKey={0} readOnly={false} onReverted={() => {}} onWriteDenied={() => {}} />);
  });
}

/** Who made each op, newest first. */
const actors = () => [...host.querySelectorAll(".db-op__actor strong")].map((s) => s.textContent);
/** The person each agent op was for, newest first. */
const fors = () => [...host.querySelectorAll(".db-op__for")].map((s) => s.textContent);

// The name cache lives for the file, so each case names its own people.
describe("ActivityPanel: who made a change", () => {
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

/** What each op says, newest first. */
const lines = () => [...host.querySelectorAll(".db-op__summary")].map((p) => p.textContent);

describe("ActivityPanel: what a change did", () => {
  const insert = { kind: "rows.insert", table: "Projects", rows: 3, imported: false } as const;
  const ops = () => [
    op(3, { actor: "carol", kind: "revert", summary: 'Reverted: Inserted 3 rows into "Projects"', detail: { kind: "revert", of: insert }, revertible: false }),
    op(2, {
      actor: "carol",
      summary: 'Updated 1 row in "Projects" (Name, Due, Owner, …)',
      detail: { kind: "rows.update", table: "Projects", rows: 1, columns: ["Name", "Due", "Owner"], more_columns: true },
    }),
    op(1, { actor: "carol", kind: "rows.insert", summary: 'Inserted 3 rows into "Projects"', detail: insert, reverted_by: "op_3" }),
    op(0, { actor: "carol", summary: "Recorded before ops carried detail" }),
  ];

  afterEach(async () => {
    await loadUiLanguage("en");
  });

  it("says each change from its detail, in English", async () => {
    users.resolve.mockResolvedValue({ users: [] });
    await mount(ops());
    expect(lines()).toEqual([
      "Reverted: Inserted 3 rows into “Projects”",
      "Updated 1 row in “Projects” (Name, Due, Owner, …)",
      "Inserted 3 rows into “Projects”",
      "Recorded before ops carried detail",
    ]);
  });

  it("says each change in the reader’s language, and an op without detail as recorded", async () => {
    users.resolve.mockResolvedValue({ users: [] });
    await loadUiLanguage("de");
    await mount(ops());
    expect(lines()).toEqual([
      "Zurückgenommen: 3 Zeilen in „Projects“ eingefügt",
      "1 Zeile in „Projects“ aktualisiert (Name, Due, Owner, …)",
      "3 Zeilen in „Projects“ eingefügt",
      "Recorded before ops carried detail",
    ]);
    expect([...host.querySelectorAll(".db-op__foot")].map((f) => f.textContent)).toEqual(["", "Zurücknehmen", "Zurückgenommen", "Zurücknehmen"]);
  });
});
