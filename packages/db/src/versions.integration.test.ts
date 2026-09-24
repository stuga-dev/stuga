import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSchema } from "./schema/migrate.js";
import { createDoc, getDoc } from "./docs.js";
import { indexDoc } from "./search.js";
import { recordVersion, listVersions, deleteVersion, previousVersionSeq } from "./versions.js";
import type { Sql } from "./client.js";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("versions", () => {
  let sql: Sql;
  const WS = "ws-test";

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE docs CASCADE`;
    await seedWorkspaces(sql, WS);
  });

  it("listVersions returns seq as a JS number", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "v1", owner: "user:alice", title: "Doc", aclPrincipals: ["user:alice"] });
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
      docId: "v1",
      snapshotSeq: 3,
      title: "Doc",
      searchText: "body",
      embeddingHash: "h",
      chunks: [],
    });
    await recordVersion(sql, { docId: "v1", seq: 3, authors: ["user:alice"], blobKey: "v1/3.bin" });

    const versions = await listVersions(sql, "v1");
    expect(versions).toHaveLength(1);
    const v = versions[0]!;
    expect(typeof v.seq).toBe("number");
    expect(v.seq).toBe(3);
    expect(Number.isInteger(v.seq)).toBe(true);
  });

  it("carries the character counts, and stores NULL rather than 0 when they are unknown", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "v5", owner: "user:dana", title: "Doc5", aclPrincipals: ["user:dana"] });
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
      docId: "v5",
      snapshotSeq: 2,
      title: "Doc5",
      searchText: "body",
      embeddingHash: "h",
      chunks: [],
    });
    await recordVersion(sql, { docId: "v5", seq: 1, authors: ["user:dana"], blobKey: "v5/1.bin" });
    await recordVersion(sql, {
      docId: "v5",
      seq: 2,
      authors: ["user:dana"],
      blobKey: "v5/2.bin",
      chars: 1280,
      charsAdded: 312,
      charsRemoved: 45,
    });

    const [newest, oldest] = await listVersions(sql, "v5");
    expect(newest).toMatchObject({ seq: 2, chars: 1280, chars_added: 312, chars_removed: 45 });
    expect(typeof newest!.chars_added).toBe("number");
    expect(oldest).toMatchObject({ seq: 1, chars: null, chars_added: null, chars_removed: null });
  });

  it("keeps a genuine zero change distinct from an unknown one", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "v6", owner: "user:dana", title: "Doc6", aclPrincipals: ["user:dana"] });
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
      docId: "v6",
      snapshotSeq: 1,
      title: "Doc6",
      searchText: "body",
      embeddingHash: "h",
      chunks: [],
    });
    await recordVersion(sql, {
      docId: "v6",
      seq: 1,
      authors: ["user:dana"],
      blobKey: "v6/1.bin",
      chars: 900,
      charsAdded: 0,
      charsRemoved: 0,
    });
    const v = (await listVersions(sql, "v6"))[0]!;
    expect(v.chars_added).toBe(0);
    expect(v.chars_added).not.toBeNull();
  });

  it("previousVersionSeq skips snapshot seqs that never became versions", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "v7", owner: "user:erin", title: "Doc7", aclPrincipals: ["user:erin"] });
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
      docId: "v7",
      snapshotSeq: 4,
      title: "Doc7",
      searchText: "body",
      embeddingHash: "h",
      chunks: [],
    });
    await recordVersion(sql, { docId: "v7", seq: 1, authors: [], blobKey: "v7/1.bin" });
    await recordVersion(sql, { docId: "v7", seq: 4, authors: [], blobKey: "v7/4.bin" });

    expect(await previousVersionSeq(sql, "v7", 4)).toBe(1);
    expect(typeof (await previousVersionSeq(sql, "v7", 4))).toBe("number");
    expect(await previousVersionSeq(sql, "v7", 1)).toBeNull();
    expect(await previousVersionSeq(sql, "nosuchdoc", 99)).toBeNull();
  });

  it("previousVersionSeq follows a delete, so a removed version stops being a baseline", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "v8", owner: "user:erin", title: "Doc8", aclPrincipals: ["user:erin"] });
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
      docId: "v8",
      snapshotSeq: 3,
      title: "Doc8",
      searchText: "body",
      embeddingHash: "h",
      chunks: [],
    });
    for (const seq of [1, 2, 3]) await recordVersion(sql, { docId: "v8", seq, authors: [], blobKey: `v8/${seq}.bin` });
    expect(await previousVersionSeq(sql, "v8", 3)).toBe(2);
    await deleteVersion(sql, "v8", 2);
    expect(await previousVersionSeq(sql, "v8", 3)).toBe(1);
  });

  it("deleteVersion removes exactly one row and reports whether it did", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "v3", owner: "user:cara", title: "Doc3", aclPrincipals: ["user:cara"] });
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
      docId: "v3",
      snapshotSeq: 3,
      title: "Doc3",
      searchText: "body",
      embeddingHash: "h",
      chunks: [],
    });
    for (const seq of [1, 2, 3]) {
      await recordVersion(sql, { docId: "v3", seq, authors: ["user:cara"], blobKey: `v3/${seq}.bin` });
    }

    expect(await deleteVersion(sql, "v3", 2)).toBe(true);
    expect((await listVersions(sql, "v3")).map((v) => v.seq)).toEqual([3, 1]);

    expect(await deleteVersion(sql, "v3", 2)).toBe(false);
    await createDoc(sql, { workspaceId: WS, docId: "v4", owner: "user:cara", title: "Doc4", aclPrincipals: ["user:cara"] });
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
      docId: "v4",
      snapshotSeq: 1,
      title: "Doc4",
      searchText: "body",
      embeddingHash: "h",
      chunks: [],
    });
    await recordVersion(sql, { docId: "v4", seq: 1, authors: ["user:cara"], blobKey: "v4/1.bin" });
    expect(await deleteVersion(sql, "v3", 1)).toBe(true);
    expect((await listVersions(sql, "v4")).map((v) => v.seq)).toEqual([1]);
  });

  it("getDoc returns snapshot_seq as a JS number", async () => {
    await createDoc(sql, { workspaceId: WS, docId: "v2", owner: "user:bob", title: "Doc2", aclPrincipals: ["user:bob"] });
    await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
      docId: "v2",
      snapshotSeq: 7,
      title: "Doc2",
      searchText: "body",
      embeddingHash: "h",
      chunks: [],
    });
    const doc = await getDoc(sql, "v2");
    expect(doc).not.toBeNull();
    expect(typeof doc!.snapshot_seq).toBe("number");
    expect(doc!.snapshot_seq).toBe(7);
  });
});
