// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserInfo } from "../api";
import { PEER_PALETTE, colorFor } from "./identity";

const users = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../api", () => ({ Users: users }));

/** The only colour format `@tiptap/y-tiptap` accepts, lowercase as the palette is written. */
const HEX = /^#[0-9a-f]{6}$/;

/** WCAG 2.x minimum for normal-size text — the size the badge initials and the caret name tag use. */
const AA_NORMAL_TEXT = 4.5;

/** WCAG 2.x relative luminance of an `#rrggbb` colour. */
function relativeLuminance(hex: string): number {
  const channel = (offset: number): number => {
    const srgb = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colours, 1:1 … 21:1. */
function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/** The white that actually sits on these hues: badge initials and the caret name tag. */
const WHITE = "#ffffff";

/**
 * Mirrors the dark-mode caret rules in styles/editor.css, which lighten the ink
 * with color-mix (jsdom cannot evaluate it) and put near-black text on the tag.
 */
const DARK_INK_MIX = 0.65;
/** `--color-background-surface` in the dark theme: the sheet a caret is drawn on. */
const DARK_SURFACE = "#262626";
/** `.collaboration-carets__label`'s dark-theme text colour, `--color-on-light` in the neutral theme. */
const DARK_LABEL_TEXT = "#111111";

/** `color-mix(in srgb, hex <pct>, #ffffff)`, the derivation styles/editor.css applies in dark mode. */
function lightenTowardWhite(hex: string, weight: number): string {
  const channel = (offset: number): string => {
    const mixed = Math.round(parseInt(hex.slice(offset, offset + 2), 16) * weight + 255 * (1 - weight));
    return mixed.toString(16).padStart(2, "0");
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** Seeds shaped like real aliases, emails and ids, not all ASCII. */
const REALISTIC_SEEDS = [
  "alice",
  "bob",
  "carol",
  "dave",
  "erin",
  "frank",
  "grace",
  "heidi",
  "ivan",
  "judy",
  "mallory",
  "olivia",
  "peggy",
  "rupert",
  "trent",
  "wendy",
  "alice@example.com",
  "bob@example.com",
  "carol@stuga.dev",
  "dave@acme.co.uk",
  "erin.smith@example.org",
  "frank_j@mail.example",
  "01J8ZC1F0X0000000000000001",
  "01J8ZC1F0X0000000000000002",
  "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "李雷",
  "韩梅梅",
  "佐藤太郎",
  "김민준",
  "Александр",
  "Ελένη",
  "محمد",
  "🦊 Fox",
  "Liv 🚀",
  "🐙",
  "agent:planner",
  "group:editors",
];

/**
 * Identity colours reach y-tiptap, which accepts only 6-digit hex and appends an
 * alpha suffix, and carry white text on badges and caret tags.
 */
describe("PEER_PALETTE", () => {
  it("is ten distinct lowercase 6-digit hex colours", () => {
    expect(PEER_PALETTE).toHaveLength(10);
    expect(new Set(PEER_PALETTE).size).toBe(PEER_PALETTE.length);
    for (const color of PEER_PALETTE) expect(color).toMatch(HEX);
  });

  it("clears WCAG AA against white for every entry, because white text sits on all of them", () => {
    for (const color of PEER_PALETTE) {
      const ratio = contrastRatio(color, WHITE);
      expect(ratio, `${color} vs white is ${ratio.toFixed(2)}:1, below AA ${AA_NORMAL_TEXT}:1`).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT,
      );
    }
  });

  it("has a length that divides 360, so the hash fold stays uniform", () => {
    expect(360 % PEER_PALETTE.length).toBe(0);
  });
});

describe("the dark theme's derived caret ink", () => {
  it("stays visible as a caret line against the dark sheet", () => {
    // 3:1: the WCAG floor for a non-text graphical object such as the caret line.
    for (const color of PEER_PALETTE) {
      const ink = lightenTowardWhite(color, DARK_INK_MIX);
      const ratio = contrastRatio(ink, DARK_SURFACE);
      expect(ratio, `${color} lightens to ${ink}, ${ratio.toFixed(2)}:1 on the dark sheet`).toBeGreaterThanOrEqual(3);
    }
  });

  it("still carries the name tag's text once lightened", () => {
    for (const color of PEER_PALETTE) {
      const ink = lightenTowardWhite(color, DARK_INK_MIX);
      const ratio = contrastRatio(DARK_LABEL_TEXT, ink);
      expect(ratio, `${color} -> ${ink}, ${ratio.toFixed(2)}:1 for the tag's text`).toBeGreaterThanOrEqual(
        AA_NORMAL_TEXT,
      );
    }
  });
});

describe("colorFor", () => {
  it("returns a palette entry in y-tiptap's hex format for every seed", () => {
    for (const seed of [...REALISTIC_SEEDS, "", " ", "a".repeat(500)]) {
      const color = colorFor(seed);
      expect(color, `colorFor(${JSON.stringify(seed)})`).toMatch(HEX);
      expect(PEER_PALETTE as readonly string[], `colorFor(${JSON.stringify(seed)})`).toContain(color);
    }
  });

  it("is deterministic: one seed always gets the same colour", () => {
    for (const seed of REALISTIC_SEEDS) {
      const first = colorFor(seed);
      expect(colorFor(seed)).toBe(first);
        expect(colorFor(seed.split("").join(""))).toBe(first);
    }
  });

  it("spreads realistic seeds across the palette instead of clumping", () => {
    const counts = new Map<string, number>();
    for (const seed of REALISTIC_SEEDS) {
      const color = colorFor(seed);
      counts.set(color, (counts.get(color) ?? 0) + 1);
    }

    expect(counts.size).toBeGreaterThanOrEqual(Math.ceil(PEER_PALETTE.length * 0.7));
    const busiest = Math.max(...counts.values());
    expect(busiest).toBeLessThanOrEqual(REALISTIC_SEEDS.length / 3);
  });
});

describe("the user directory", () => {
  const DIRECTORY: UserInfo[] = [
    { alias: "u_ada", username: "ada", display_name: "Ada", email: "ada@example.com" },
    { alias: "u_liv", username: "liv", display_name: "", email: "liv@example.com" },
    { alias: "u_kim", username: null, display_name: "", email: "kim@example.com" },
    // Shaped as the node mints an account's alias.
    { alias: "u_Bb81bob4TqeW9nJs", username: "bob", display_name: "Bob", email: null },
  ];
  const BOB = "u_Bb81bob4TqeW9nJs";

  /** A fresh module, so no earlier case's cache answers for this one. */
  async function directory() {
    vi.resetModules();
    return import("./identity");
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    users.resolve.mockReset();
    users.resolve.mockImplementation(async (ids: string[]) => ({ users: DIRECTORY.filter((u) => ids.includes(u.alias)) }));
  });

  it("looks up the people behind ACL principals, ledger aliases and co-authors, and nothing else", async () => {
    const { resolveNames } = await directory();
    resolveNames(["user:u_ada", "u_liv", "panel:u_zoe", "agent:ci", "group:eng", "org:ws_1", null]);
    await settle();
    expect(users.resolve).toHaveBeenCalledTimes(1);
    expect(users.resolve).toHaveBeenCalledWith(["u_ada", "u_liv", "u_zoe"]);
  });

  it("asks about a person once, whether the first request is in flight or answered", async () => {
    const { resolveNames } = await directory();
    resolveNames(["u_ada"]);
    resolveNames(["u_ada"]);
    await settle();
    resolveNames(["u_ada", "user:u_ada"]);
    await settle();
    expect(users.resolve).toHaveBeenCalledTimes(1);
  });

  it("asks again after a failed lookup", async () => {
    users.resolve.mockRejectedValueOnce(new Error("down"));
    const { resolveNames, actorName } = await directory();
    resolveNames(["u_ada"]);
    await settle();
    expect(actorName("u_ada")).toBe("u_ada");
    resolveNames(["u_ada"]);
    await settle();
    expect(users.resolve).toHaveBeenCalledTimes(2);
    expect(actorName("u_ada")).toBe("Ada");
  });

  it("names a ledger alias as a person reads it", async () => {
    const { resolveNames, actorName, principalName } = await directory();
    resolveNames(["u_ada", "u_liv", "u_kim", "u_gone"]);
    await settle();
    expect(actorName("u_ada")).toBe("Ada");
    expect(actorName("user:u_ada")).toBe("Ada");
    expect(principalName("user:u_ada")).toBe("Ada");
    // No display name: the username stands in, then the email.
    expect(actorName("u_liv")).toBe("liv");
    expect(actorName("u_kim")).toBe("kim@example.com");
    // Unknown to the directory: the alias names itself.
    expect(actorName("u_gone")).toBe("u_gone");
    expect(actorName("agent:claude-connector")).toBe("claude-connector");
    expect(actorName("panel:u_ada")).toBe("AI co-author");
  });

  it("gives a person the handle that tells them apart from a namesake, and nobody else one", async () => {
    const { resolveNames, actorHandle } = await directory();
    resolveNames(["u_ada", "u_liv", "u_kim", "u_gone"]);
    await settle();
    expect(actorHandle("u_ada")).toBe("@ada");
    expect(actorHandle("user:u_ada")).toBe("@ada");
    expect(actorHandle("u_liv")).toBe("@liv");
    // The email is already the name, so it is not said twice.
    expect(actorHandle("u_kim")).toBeNull();
    expect(actorHandle("u_gone")).toBeNull();
    expect(actorHandle("panel:u_ada")).toBeNull();
    expect(actorHandle("agent:ci")).toBeNull();
  });

  it("tells a name still to come from one that has arrived", async () => {
    let answer!: (r: { users: UserInfo[] }) => void;
    users.resolve.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const { resolveNames, nameLoading } = await directory();
    const gone = "u_QH52formerMember";
    // Before the lookup starts too: a first render comes before its effect.
    expect(nameLoading(`user:${BOB}`)).toBe(true);
    resolveNames([`user:${BOB}`, gone]);
    await settle();
    expect(nameLoading(`user:${BOB}`)).toBe(true);
    expect(nameLoading(BOB)).toBe(true);
    expect(nameLoading(`panel:${BOB}`)).toBe(true);
    answer({ users: [DIRECTORY.find((u) => u.alias === BOB)!] });
    await settle();
    expect(nameLoading(`user:${BOB}`)).toBe(false);
    // Unknown to the directory.
    expect(nameLoading(gone)).toBe(false);
    // Nobody to look up.
    expect(nameLoading("agent:ci")).toBe(false);
    expect(nameLoading("group:eng")).toBe(false);
    expect(nameLoading("org:ws_1")).toBe(false);
  });

  it("stops waiting for a name whose lookup failed, and names them once a retry succeeds", async () => {
    users.resolve.mockRejectedValueOnce(new Error("down"));
    const { resolveNames, nameLoading, principalLabel } = await directory();
    resolveNames([BOB]);
    await settle();
    expect(nameLoading(BOB)).toBe(false);
    expect(principalLabel(`user:${BOB}`)).toBe("u_Bb81…");
    resolveNames([BOB]);
    await settle();
    expect(principalLabel(`user:${BOB}`)).toBe("Bob");
  });

  it("reads someone the directory does not know, such as a former member, by the short alias", async () => {
    const gone = "u_QH52formerMember";
    const { resolveNames, nameLoading, principalLabel, principalName, actorName } = await directory();
    resolveNames([gone]);
    await settle();
    expect(nameLoading(gone)).toBe(false);
    expect(principalName(`user:${gone}`)).toBe("u_QH52…");
    expect(principalLabel(`user:${gone}`)).toBe("u_QH52…");
    // The ledger keeps the whole alias.
    expect(actorName(gone)).toBe(gone);
    resolveNames([gone]);
    await settle();
    expect(users.resolve).toHaveBeenCalledTimes(1);
  });

  it("reads an author that is no account, such as an agent's name or id, whole and at once", async () => {
    const { resolveNames, nameLoading, authorLabel, principalLabel } = await directory();
    const authors = ["DeepSeek Harness", "Claude Desktop", "agent-conn-AbCdEf123456", "AI co-author"];
    for (const a of authors) {
      expect(nameLoading(`user:${a}`)).toBe(false);
      expect(authorLabel(a)).toBe(a);
    }
    resolveNames(authors.map((a) => `user:${a}`));
    await settle();
    for (const a of authors) expect(authorLabel(a)).toBe(a);
    expect(principalLabel("user:DeepSeek Harness")).toBe("DeepSeek Harness");
  });

  it("reads Sample agent, the one agent with no key, by its name", async () => {
    const { nameLoading, authorLabel } = await directory();
    expect(nameLoading("user:agent-sample")).toBe(false);
    expect(authorLabel("agent-sample")).toBe("Sample agent");
  });

  it("reads an imported author as its archive named it, never as an account, and never looks it up", async () => {
    const { resolveNames, nameLoading, authorLabel } = await directory();
    resolveNames(["u_ada"]);
    await settle();
    users.resolve.mockClear();
    for (const author of ["imported:Liv", "imported:u_ada", "imported:liv@example.com", "imported:Ops team"]) {
      expect(nameLoading(`user:${author}`)).toBe(false);
      resolveNames([`user:${author}`, author]);
    }
    await settle();
    expect(users.resolve).not.toHaveBeenCalled();
    expect(authorLabel("imported:Liv")).toBe("Liv · imported");
    // Not the account that alias names, and an email stays whole.
    expect(authorLabel("imported:u_ada")).toBe("u_ada · imported");
    expect(authorLabel("imported:liv@example.com")).toBe("liv@example.com · imported");
    expect(authorLabel("imported:Ops team")).toBe("Ops team · imported");
  });

  it("takes the handle from rows already in hand", async () => {
    const { rememberUsers, actorHandle } = await directory();
    rememberUsers([{ alias: "u_ann", username: null, display_name: "Ann", email: "ann@example.com" }]);
    expect(actorHandle("u_ann")).toBe("ann@example.com");
    rememberUsers([{ alias: "u_ann", username: "ann", display_name: "Ann", email: "ann@example.com" }]);
    expect(actorHandle("u_ann")).toBe("@ann");
  });
});
