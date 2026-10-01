import { describe, expect, it } from "vitest";
import { MAX_SCORED, REMOTE_MIN_CODE_POINTS, codePoints, remotePasswordOk, strengthInputs } from "./index.js";

const none: string[] = [];

describe("remotePasswordOk", () => {
  it("counts code points, so an emoji is one character", () => {
    expect(codePoints("😀")).toBe(1);
    expect(codePoints("é")).toBe(1);
    const fourteen = "kx7😀wq🙂zt9🎉mv2";
    expect(codePoints(fourteen)).toBe(14);
    expect(remotePasswordOk(fourteen, none)).toMatchObject({ ok: false, codePoints: 14, score: null });
    expect(remotePasswordOk(`${fourteen}r`, none)).toMatchObject({ ok: true, codePoints: 15 });
  });

  it("refuses 14 characters however strong, and takes 15 strong ones", () => {
    expect(remotePasswordOk("Vq7#mZp2!xR9wL", none).ok).toBe(false);
    expect(remotePasswordOk("Vq7#mZp2!xR9wLk", none).ok).toBe(true);
    expect(REMOTE_MIN_CODE_POINTS).toBe(15);
  });

  it("refuses long but guessable passwords", () => {
    for (const weak of ["password1234567", "qwertyuiopasdfgh", "aaaaaaaaaaaaaaaa", "1234567890123456", "passwordpassword"]) {
      expect(remotePasswordOk(weak, none).ok, weak).toBe(false);
    }
  });

  it("takes passphrases, with spaces and characters beyond ASCII", () => {
    for (const strong of ["trumpet walnut ceiling", "trumpet walnut ceiling 7", "fjällräven kåsa möte", "冬の朝に紅茶と猫が窓辺で眠っている"]) {
      expect(remotePasswordOk(strong, none).ok, strong).toBe(true);
    }
  });

  it("scores lower for a password built from the username or the node's name", () => {
    const pw = "larssonstugaoffice";
    const plain = remotePasswordOk(pw, none);
    const known = remotePasswordOk(pw, strengthInputs({ username: "larsson", nodeName: "Stuga Office" }));
    expect(known.score!).toBeLessThan(plain.score!);
  });

  it("scores only the first MAX_SCORED code units", () => {
    const head = "trumpet walnut ceiling ".repeat(3).slice(0, MAX_SCORED);
    expect(remotePasswordOk(`${head}aaaa`, none)).toEqual(remotePasswordOk(`${head}zq#9`, none));
    // A weak start is not rescued by a strong tail past the limit.
    const weak = "a".repeat(MAX_SCORED);
    expect(remotePasswordOk(`${weak}Vq7#mZp2!xR9wLk`, none).ok).toBe(false);
  });

  it("never splits a character at the limit", () => {
    const astral = "😀".repeat(40); // 80 code units
    expect(() => remotePasswordOk(astral, none)).not.toThrow();
  });
});

describe("strengthInputs", () => {
  it("keeps each value whole and its words", () => {
    const inputs = strengthInputs({ username: "bo", nodeName: "North Office", hostLabel: "k7f3q2", displayName: "Bo Larsson" });
    expect(inputs).toEqual(expect.arrayContaining(["bo", "north office", "north", "office", "k7f3q2", "bo larsson", "larsson"]));
    // Words shorter than three characters are kept only as part of the whole value.
    expect(inputs.filter((v) => v === "bo")).toHaveLength(1);
  });

  it("skips what is missing", () => {
    expect(strengthInputs({ username: "liv", nodeName: null, hostLabel: "" })).toEqual(["liv"]);
  });

  it("splits on punctuation as well as spaces", () => {
    expect(strengthInputs({ username: "ana-maria_x" })).toEqual(expect.arrayContaining(["ana-maria_x", "ana", "maria"]));
  });

  it("gives the form a superset of what the node uses, which can only lower the score", () => {
    const node = strengthInputs({ username: "bo", nodeName: "North Office", hostLabel: "k7f3q2" });
    const form = strengthInputs({ username: "bo", nodeName: "North Office", hostLabel: "k7f3q2", displayName: "Bo Larsson" });
    expect(form).toEqual(expect.arrayContaining(node));
    const pw = "larsson north office walnut";
    expect(remotePasswordOk(pw, form).score!).toBeLessThanOrEqual(remotePasswordOk(pw, node).score!);
  });
});
