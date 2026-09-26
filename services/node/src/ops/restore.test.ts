import { describe, expect, it } from "vitest";
import { withoutSearchIndexes } from "./restore.js";

/** A dump's table of contents as `pg_restore --list` prints it, cut down. */
const TOC = `;
; Archive created at 2026-09-25 16:55:23 PDT
;
; Selected TOC Entries:
;
3; 3079 320418 EXTENSION - pg_search 
227; 1259 321321 TABLE public docs stuga
4940; 0 321321 TABLE DATA public docs stuga
4789; 2606 321328 CONSTRAINT public docs docs_pkey stuga
4786; 1259 321329 INDEX public docs_bm25_v1 stuga
4950; 0 0 COMMENT public INDEX docs_bm25_v1 stuga
4787; 1259 321330 INDEX public docs_bm25_v1_ko stuga
4951; 0 0 COMMENT public INDEX docs_bm25_v1_ko stuga
4788; 1259 321332 INDEX public doc_chunks_bm25_v1 
4790; 1259 321331 INDEX public docs_workspace_idx stuga
4952; 0 0 COMMENT public INDEX docs_workspace_idx stuga
`;

describe("withoutSearchIndexes", () => {
  it("leaves out the search indexes and their comments, and keeps every other entry in its order", () => {
    expect(withoutSearchIndexes(TOC)).toBe(`;
; Archive created at 2026-09-25 16:55:23 PDT
;
; Selected TOC Entries:
;
3; 3079 320418 EXTENSION - pg_search 
227; 1259 321321 TABLE public docs stuga
4940; 0 321321 TABLE DATA public docs stuga
4789; 2606 321328 CONSTRAINT public docs docs_pkey stuga
4790; 1259 321331 INDEX public docs_workspace_idx stuga
4952; 0 0 COMMENT public INDEX docs_workspace_idx stuga
`);
  });
});
