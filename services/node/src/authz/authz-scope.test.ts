import { describe, expect, it } from "vitest";
import type { DocRow, FolderRow } from "@stuga/db";
import type { Ctx } from "../auth/context.js";
import { canCommentDoc, canReadDoc, canReadFolder, canWriteDoc, canWriteFolder, inScope, scopeFolderIds } from "./authz.js";

function ctx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    sql: {} as Ctx["sql"],
    alias: "agent-1",
    displayName: "bot",
    isAgent: true,
    onBehalfOf: "alice",
    env: {} as Ctx["env"],
    principals: ["agent:agent-1", "user:alice", "org:ws1"],
    workspaceId: "ws1",
    role: "member",
    ...overrides,
  } as Ctx;
}

function doc(overrides: Partial<DocRow> = {}): DocRow {
  return {
    doc_id: "d1",
    workspace_id: "ws1",
    owner: "user:alice",
    title: "T",
    title_source: "heading",
    doc_type: "prose",
    parent_id: "f-in",
    snapshot_seq: 0,
    version_floor: null,
    trashed: false,
    trashed_at: null,
    created_at: "",
    updated_at: "",
    acl_principals: ["user:alice", "org:ws1"],
    acl_writers: ["user:alice", "org:ws1"],
    acl_commenters: [],
    inherits_perms: true,
    locked: false,
    locked_by: null,
    locked_at: null,
    search_hidden: false,
    own_grants: { p: [], w: [], c: [] },
    created_by: "user:alice",
    agent_mode: "review",
    agent_instructions: "",
    page_of: null,
    page_row: null,
    ...overrides,
  };
}

function folder(overrides: Partial<FolderRow> = {}): FolderRow {
  return {
    folder_id: "f-in",
    workspace_id: "ws1",
    parent_id: null,
    owner: "user:alice",
    title: "F",
    acl_principals: ["user:alice", "org:ws1"],
    acl_writers: ["user:alice", "org:ws1"],
    inherits_perms: true,
    own_grants: { p: [], w: [], c: [] },
    agent_instructions: "",
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

const scoped = ctx({ scope: { folders: ["f-in", "f-sub"], readOnly: false, credentialId: "k1" } });
const readOnly = ctx({ scope: { folders: null, readOnly: true, credentialId: "k2" } });

describe("inScope", () => {
  it("is always true without a scope", () => {
    expect(inScope(ctx(), null)).toBe(true);
    expect(inScope(ctx(), "anything")).toBe(true);
  });
  it("with a scope, only the listed folders count, and the root never does", () => {
    expect(inScope(scoped, "f-in")).toBe(true);
    expect(inScope(scoped, "f-sub")).toBe(true);
    expect(inScope(scoped, "f-out")).toBe(false);
    expect(inScope(scoped, null)).toBe(false);
  });
  it("scopeFolderIds hands listing queries the same set, or null", () => {
    expect(scopeFolderIds(ctx())).toBeNull();
    expect(scopeFolderIds(scoped)).toEqual(["f-in", "f-sub"]);
  });
});

describe("canReadDoc", () => {
  it("needs tenant, ACL and scope together", () => {
    expect(canReadDoc(scoped, doc())).toBe(true);
    expect(canReadDoc(scoped, doc({ parent_id: "f-out" }))).toBe(false);
    expect(canReadDoc(scoped, doc({ parent_id: null }))).toBe(false);
    expect(canReadDoc(scoped, doc({ workspace_id: "ws2" }))).toBe(false);
    expect(canReadDoc(scoped, doc({ acl_principals: ["user:bob"] }))).toBe(false);
  });
  it("an unscoped key or a human is bounded by the ACL alone", () => {
    expect(canReadDoc(ctx(), doc({ parent_id: null }))).toBe(true);
    expect(canReadDoc(ctx({ isAgent: false, principals: ["user:alice", "org:ws1"] }), doc({ parent_id: "f-out" }))).toBe(true);
  });
  it("a read-only key still reads", () => {
    expect(canReadDoc(readOnly, doc())).toBe(true);
  });
});

describe("write and comment predicates", () => {
  it("a read-only key never writes or comments, whatever the ACL grants", () => {
    expect(canWriteDoc(readOnly, doc())).toBe(false);
    expect(canCommentDoc(readOnly, doc({ acl_commenters: ["agent:agent-1"] }))).toBe(false);
    expect(canWriteFolder(readOnly, folder())).toBe(false);
  });
  it("a scoped key writes inside its folders and nowhere else", () => {
    expect(canWriteDoc(scoped, doc())).toBe(true);
    expect(canWriteDoc(scoped, doc({ parent_id: "f-out" }))).toBe(false);
  });
  it("the writer tier is still required", () => {
    expect(canWriteDoc(scoped, doc({ acl_writers: ["user:alice"] , acl_principals: ["user:alice", "org:ws1"]}))).toBe(true);
    expect(canWriteDoc(ctx({ principals: ["agent:agent-1"] }), doc({ acl_principals: ["agent:agent-1"], acl_writers: ["user:alice"] }))).toBe(false);
  });
  it("commenters comment; readers do not", () => {
    const readerOnly = ctx({ principals: ["agent:agent-1"] });
    expect(canCommentDoc(readerOnly, doc({ acl_principals: ["agent:agent-1"], acl_writers: ["user:alice"], acl_commenters: [] }))).toBe(false);
    expect(canCommentDoc(readerOnly, doc({ acl_principals: ["agent:agent-1"], acl_writers: ["user:alice"], acl_commenters: ["agent:agent-1"] }))).toBe(true);
  });
});

describe("folders", () => {
  it("a folder is readable when it is in the scoped set and the ACL allows", () => {
    expect(canReadFolder(scoped, folder())).toBe(true);
    expect(canReadFolder(scoped, folder({ folder_id: "f-out" }))).toBe(false);
    expect(canReadFolder(scoped, folder({ acl_principals: ["user:bob"] }))).toBe(false);
    expect(canReadFolder(ctx(), folder({ folder_id: "f-out" }))).toBe(true);
  });
  it("writing a folder needs the writer tier and a writable key", () => {
    expect(canWriteFolder(scoped, folder())).toBe(true);
    expect(canWriteFolder(scoped, folder({ acl_writers: ["user:bob"] }))).toBe(false);
  });
});
