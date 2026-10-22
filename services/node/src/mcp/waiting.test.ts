import { describe, expect, it } from "vitest";
import { landsIn, netChanges, relevance } from "./waiting.js";

// Globex as the eval's wiki has it, in the serializer's Markdown.
const GLOBEX =
  "# Globex\n\nGlobex is a manufacturing group in Lyon and a customer since 2025.\n\n## Contacts\n\n" +
  "* Priya Shah, procurement lead, is the main contact.\n\n## Contract\n\n* Monthly contract, cancelled with 30 days' notice.\n\n" +
  "* The refund window is 7 days from delivery.\n\n## Facts\n\n* Globex prefers email to phone calls.";

// One run's four waiting changes, as the eval's agent proposed them (run 3, #3, #11 and #12): the refund window last.
const GLOBEX_RUN = [
  { old_string: "* Globex prefers email to phone calls.", new_string: "* Globex prefers email to phone calls.\n\n* Globex wants invoices sent to ap@globex.example." },
  { old_string: "* Priya Shah, procurement lead, is the main contact.", new_string: "* Tom Becker is the main contact.\n\n* Priya Shah, procurement lead, is the main contact." },
  {
    old_string: "* Priya Shah, procurement lead, is the main contact.",
    new_string: "* Priya Shah, the previous main contact (procurement lead), has moved to the finance department.",
  },
  { old_string: "* The refund window is 7 days from delivery.", new_string: "* The refund window is 14 days from delivery (customer sync, 2026-10-20)." },
];

describe("netChanges", () => {
  it("tells each change of a run against the approved text, where it lands, in the order of the text", () => {
    expect(netChanges(GLOBEX, GLOBEX_RUN)).toEqual({
      changes: [
        {
          approvedNow: "",
          afterApproval: "* Tom Becker is the main contact.",
          addsBefore: "* Priya Shah, procurement lead, is the main contact.",
          section: "Globex > Contacts",
        },
        {
          approvedNow: "* Priya Shah, procurement lead, is the main contact.",
          afterApproval: "* Priya Shah, the previous main contact (procurement lead), has moved to the finance department.",
          section: "Globex > Contacts",
        },
        {
          approvedNow: "* The refund window is 7 days from delivery.",
          afterApproval: "* The refund window is 14 days from delivery (customer sync, 2026-10-20).",
          section: "Globex > Contract",
        },
        {
          approvedNow: "",
          afterApproval: "* Globex wants invoices sent to ap@globex.example.",
          addsAfter: "* Globex prefers email to phone calls.",
          section: "Globex > Facts",
        },
      ],
      unread: 0,
    });
  });

  it("makes a change to another waiting change one with it, against a page with no approved text (eval run 3, #19)", () => {
    // The agent appended a sentence twice, then removed the first copy: the removal edits its own waiting text.
    const run = [
      {
        old_string: "",
        new_string: "Initech is a new customer.\n\n## Contacts\n\n* Ana Ruiz is the contact person at Initech.\n\n## Facts\n\n* Initech is a new customer.",
      },
      { old_string: "Initech is a new customer.\n\n", new_string: "" },
    ];
    expect(netChanges("", run)).toEqual({
      changes: [
        {
          approvedNow: "",
          afterApproval: "## Contacts\n\n* Ana Ruiz is the contact person at Initech.\n\n## Facts\n\n* Initech is a new customer.",
          section: "",
        },
      ],
      unread: 0,
    });
  });

  it("tells a change to a change once, from the approved text to where it ends", () => {
    const approved = "## Contract\n\n* The refund window is 14 days.\n\n* Invoices are paid net 30.";
    const run = [
      { old_string: "* The refund window is 14 days.", new_string: "* The refund window is 30 days." },
      { old_string: "* The refund window is 30 days.", new_string: "* The refund window is 45 days." },
    ];
    expect(netChanges(approved, run).changes).toEqual([
      { approvedNow: "* The refund window is 14 days.", afterApproval: "* The refund window is 45 days.", section: "Contract" },
    ]);
    // Changes that undo each other change nothing.
    expect(netChanges(approved, [run[0]!, { old_string: "* The refund window is 30 days.", new_string: "* The refund window is 14 days." }])).toEqual({
      changes: [],
      unread: 0,
    });
  });

  it("counts a hunk the approved text no longer holds, and tells the rest", () => {
    const approved = "## Contract\n\n* The refund window is 14 days.";
    const out = netChanges(approved, [
      { old_string: "* Gone sentence.", new_string: "* New sentence." },
      { old_string: "* The refund window is 14 days.", new_string: "* The refund window is 30 days." },
    ]);
    expect(out).toEqual({
      changes: [{ approvedNow: "* The refund window is 14 days.", afterApproval: "* The refund window is 30 days.", section: "Contract" }],
      unread: 1,
    });
  });
});

describe("relevance and landsIn", () => {
  const [tom, priya, refund, invoices] = netChanges(GLOBEX, GLOBEX_RUN).changes;

  it("counts the words of a question a change holds", () => {
    expect(relevance("Globex refund window", refund!)).toBe(2);
    expect(relevance("Globex refund window", invoices!)).toBe(1);
    expect(relevance("Globex refund window", tom!)).toBe(0);
    expect(relevance("", refund!)).toBe(0);
  });

  it("places a change on the passage holding the text it changes, an addition on its section's, else nowhere", () => {
    const passages = [
      { heading_path: "Globex > Contract", content: "## Contract\n\n* Monthly contract, cancelled with 30 days' notice.\n\n* The refund window is 7 days from delivery." },
      { heading_path: "Globex", content: "# Globex\n\nGlobex is a manufacturing group in Lyon and a customer since 2025." },
      { heading_path: "Globex > Facts", content: "## Facts\n\n* Globex prefers email to phone calls." },
      { heading_path: "Globex > Contacts", content: "## Contacts\n\n* Priya Shah, procurement lead, is the main contact." },
    ];
    expect([tom, priya, refund, invoices].map((c) => landsIn(c!, passages))).toEqual([3, 3, 0, 2]);
    // An addition is never put on the first passage for want of its own.
    expect(landsIn(invoices!, passages.slice(0, 2))).toBe(-1);
  });
});
