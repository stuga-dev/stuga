// A small hand-labelled corpus guarding ranking quality; semantic cases use fixed vectors.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { seedWorkspaces } from "./testing/fixtures.js";
import { initSearchSchema } from "./testing/search-schema.js";
import { createDoc } from "./docs.js";
import { indexDoc, searchDocs } from "./search.js";
import type { Sql } from "./client.js";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";

const URL = process.env.TEST_DATABASE_URL;

const DIMS = 1024;
/** A vector pointing mostly along axis `i`. */
function vec(i: number): number[] {
  const v = Array.from({ length: DIMS }, () => 0.01);
  v[i % DIMS] = 1;
  return v;
}

interface SeedDoc {
  id: string;
  title: string;
  body: string;
  /** Per-chunk vectors; omit for a keyword-only doc (no semantic leg). */
  chunkVecs?: number[][];
}

describe.skipIf(!URL)("search ranking quality", () => {
  let sql: Sql;
  const WS = "ws-test";
  const ALICE = ["user:alice"];

  const CORPUS: SeedDoc[] = [
    {
      id: "roadmap-short",
      title: "Roadmap",
      body: "The product roadmap for next quarter covers search, mobile, and billing roadmap items.",
      chunkVecs: [vec(10)],
    },
    {
      id: "roadmap-long",
      title: "Roadmap Notes Archive Document Folder Section Index Reference Page",
      body: "The product roadmap for next quarter covers search, mobile, and billing roadmap items.",
      chunkVecs: [vec(11)],
    },
    {
      id: "ocean",
      title: "Ocean Facts",
      body: "The ocean covers roughly seventy percent of the planet surface and drives global climate.",
      chunkVecs: [vec(20)],
    },
    {
      id: "physics",
      title: "Physics Notes",
      body: "Introductory notes on classical mechanics. A later section discusses spooky action at a distance.",
      chunkVecs: [vec(30), vec(42)],
    },
    {
      id: "stopwords",
      title: "The And Or",
      body: "the meeting notes about the and or were filed under the and or section",
      chunkVecs: [vec(50)],
    },
    {
      id: "cooking",
      title: "Cooking Recipes",
      body: "How to bake sourdough bread with flour, water, salt, and a little patience.",
      chunkVecs: [vec(99)],
    },
    {
      id: "retention-en",
      title: "Backup retention",
      body: "Backups are retained for thirty days, then deleted for good.",
    },
    {
      id: "holidays-en",
      title: "Holiday calendar",
      body: "The office is closed on public holidays, and backups still run.",
    },
    {
      id: "expense-zh",
      title: "报销流程",
      body: "员工提交报销单后，由部门经理审批，财务部门核对发票后付款。",
    },
    {
      id: "travel-zh",
      title: "差旅安排",
      body: "出差前需要在系统里预订机票和酒店，费用由公司统一结算，经理审批后出发。",
    },
    {
      id: "meeting-zh",
      title: "會議室使用規定",
      body: "會議室需要提前預約，使用後請保持整潔。",
    },
    {
      id: "leave-ko",
      title: "휴가 신청 안내",
      body: "연차 휴가는 최소 일주일 전에 팀장에게 신청해야 합니다. 승인 후 인사팀에 통보됩니다.",
    },
    {
      id: "security-ko",
      title: "보안 정책",
      body: "비밀번호는 90일마다 변경해야 하며 다른 사람과 공유하지 마십시오.",
    },
  ];

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSearchSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE docs CASCADE`;
    await seedWorkspaces(sql, WS);
    for (const d of CORPUS) {
      await createDoc(sql, { workspaceId: WS, docId: d.id, owner: "user:alice", title: d.title, aclPrincipals: ALICE });
      await indexDoc(sql, { embeddingDims: EMBEDDING_DIMS,
        docId: d.id,
        snapshotSeq: 1,
        title: d.title,
        searchText: d.body,
        embeddingHash: `hash-${d.id}`,
        chunks: (d.chunkVecs ?? []).map((embedding, i) => ({ content: `${d.id} chunk ${i}`, embedding, embedHash: `${d.id}-eh-${i}` })),
      });
    }
  });

  async function search(query: string, queryEmbedding: number[] | null = null, limit = 20) {
    return searchDocs(sql, { embeddingDims: EMBEDDING_DIMS, maxDistance: 0.6, workspaceId: WS, principals: ALICE, query, queryEmbedding, limit });
  }

  interface Case {
    name: string;
    query: string;
    queryEmbedding?: number[] | null;
    expected: string[];
    mustNotInclude?: string[];
    top1?: string;
  }

  const CASES: Case[] = [
    {
      name: "keyword: exact body term recalls both roadmap docs, noise excluded",
      query: "roadmap quarter",
      expected: ["roadmap-short", "roadmap-long"],
      mustNotInclude: ["cooking"],
    },
    {
      name: "keyword: distinctive term recalls the right doc as #1",
      query: "ocean planet climate",
      expected: ["ocean"],
      top1: "ocean",
      mustNotInclude: ["cooking", "roadmap-short", "roadmap-long"],
    },
    {
      name: "stopword-only query still recalls the doc that carries those words",
      // A title holds its words as written, stopwords too, so this query still has terms to match.
      query: "the and or",
      expected: ["stopwords"],
    },
    {
      name: "keyword: English finds another form of each word, the title's match first",
      query: "retaining backup",
      expected: ["retention-en"],
      top1: "retention-en",
      mustNotInclude: ["holidays-en", "cooking"],
    },
    {
      name: "keyword: a word in a title outranks the same word in a longer text",
      query: "backups",
      expected: ["retention-en", "holidays-en"],
      top1: "retention-en",
    },
    {
      name: "keyword: Chinese words find the document that holds both, not one holding only one",
      query: "报销 审批",
      expected: ["expense-zh"],
      top1: "expense-zh",
      mustNotInclude: ["travel-zh", "meeting-zh"],
    },
    {
      name: "keyword: a traditional Chinese query finds simplified text",
      query: "報銷發票",
      expected: ["expense-zh"],
      top1: "expense-zh",
      mustNotInclude: ["travel-zh"],
    },
    {
      name: "keyword: a simplified Chinese query finds traditional text",
      query: "会议室预约",
      expected: ["meeting-zh"],
      top1: "meeting-zh",
      mustNotInclude: ["expense-zh", "travel-zh"],
    },
    {
      name: "keyword: Korean words find a text where particles cling to them",
      query: "휴가 신청",
      expected: ["leave-ko"],
      top1: "leave-ko",
      mustNotInclude: ["security-ko"],
    },
    {
      name: "keyword: a Korean word inside a longer one is found",
      query: "비밀번호 변경",
      expected: ["security-ko"],
      top1: "security-ko",
      mustNotInclude: ["leave-ko"],
    },
    {
      name: "semantic: best-chunk match surfaces a doc the keyword leg misses",
      query: "quantum entanglement nonlocality",
      queryEmbedding: vec(42),
      expected: ["physics"],
      top1: "physics",
    },
  ];

  for (const c of CASES) {
    it(c.name, async () => {
      const res = await search(c.query, c.queryEmbedding ?? null);
      const ids = res.map((r) => r.doc_id);
      for (const want of c.expected) expect(ids, `expected ${want} in [${ids.join(", ")}]`).toContain(want);
      for (const no of c.mustNotInclude ?? []) expect(ids, `${no} must NOT appear`).not.toContain(no);
      if (c.top1) expect(ids[0], `top-1 should be ${c.top1}, got ${ids[0]}`).toBe(c.top1);
    });
  }

  it("keyword-only search scores exactly the keyword RRF term", async () => {
    const res = await search("ocean planet climate", null);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0]!.sem_score).toBe(0);
    expect(res[0]!.score).toBeCloseTo(1 / 61, 10);
  });

  it("identical queries return the same order", async () => {
    const a = (await search("roadmap quarter", null)).map((r) => r.doc_id);
    const b = (await search("roadmap quarter", null)).map((r) => r.doc_id);
    expect(a).toEqual(b);
  });
});
