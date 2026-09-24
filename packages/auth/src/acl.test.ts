import { describe, it, expect } from "vitest";
import {
  hasAccess,
  hasCommentAccess,
  userPrincipal,
  flattenAcl,
  materializeAcl,
  orgPrincipal,
  agentPrincipal,
} from "./acl.js";

const WS = "ws-1";

describe("hasAccess (array intersection)", () => {
  it("grants when a principal overlaps", () => {
    expect(hasAccess(["user:alice", "group:eng"], ["user:bob", "group:eng"])).toBe(true);
  });
  it("denies with no overlap", () => {
    expect(hasAccess(["user:alice"], ["user:bob", "org:all"])).toBe(false);
  });
  it("denies on empty ACL", () => {
    expect(hasAccess([], ["user:alice"])).toBe(false);
  });
  it("matches a workspace-scoped org grant", () => {
    expect(hasAccess([orgPrincipal(WS)], ["user:anyone", orgPrincipal(WS)])).toBe(true);
  });
  it("a workspace's org principal does NOT match another workspace's", () => {
    expect(hasAccess([orgPrincipal("ws-A")], ["user:x", orgPrincipal("ws-B")])).toBe(false);
  });
});

describe("agent principals", () => {
  it("intersect only with an ACL that names the agent", () => {
    const agent = agentPrincipal("bot-1");
    expect(agent).toBe("agent:bot-1");
    expect(hasAccess(["user:alice", "agent:bot-1"], [agent])).toBe(true);
    expect(hasAccess(["user:alice", orgPrincipal(WS)], [agent])).toBe(false);
  });
});

describe("userPrincipal", () => {
  it("namespaces an alias", () => {
    expect(userPrincipal("alice")).toBe("user:alice");
  });
});

describe("hasCommentAccess", () => {
  const writers = ["user:writer"];
  const commenters = ["user:commenter"];

  it.each([
    ["writer", ["user:writer"], true],
    ["commenter", ["user:commenter"], true],
    ["reader", ["user:reader"], false],
  ])("%s access resolves to %s", (_name, principals, expected) => {
    expect(hasCommentAccess(writers, commenters, principals)).toBe(expected);
  });
});

describe("flattenAcl", () => {
  it("stores a group grant as the group principal, and always includes the owner", () => {
    expect(flattenAcl("user:alice", ["group:eng", "user:dave"]).sort()).toEqual([
      "group:eng",
      "user:alice",
      "user:dave",
    ]);
  });

  it("keeps the owner principal as stored, whatever its alias looks like", () => {
    expect(flattenAcl("agent:agent-7", [])).toEqual(["agent:agent-7"]);
    expect(flattenAcl("user:agent-smith@corp.com", [])).toEqual(["user:agent-smith@corp.com"]);
  });
});

describe("materializeAcl", () => {
  it("preserves direct grants and commenters while adding inherited access", () => {
    const acl = materializeAcl(
      "user:alice",
      {
        p: ["user:direct-reader", "group:readers"],
        w: ["user:direct-writer"],
        c: ["group:commenters"],
      },
      {
        principals: ["user:inherited-reader"],
        writers: ["user:inherited-writer"],
      },
      true,
    );

    expect(acl.principals.sort()).toEqual([
      "group:commenters",
      "group:readers",
      "user:alice",
      "user:direct-reader",
      "user:direct-writer",
      "user:inherited-reader",
      "user:inherited-writer",
    ]);
    expect(acl.writers.sort()).toEqual([
      "user:alice",
      "user:direct-writer",
      "user:inherited-writer",
    ]);
    expect(acl.commenters).toEqual(["group:commenters"]);
  });
});
