/**
 * en-XA, a development-only language: English with accented letters, padded a third longer and
 * bracketed, so text that skipped the catalog or a layout that clips a longer language shows at
 * a glance. Only literal text changes; ICU arguments, plural keywords and tags pass through.
 */
const ACCENTED: Record<string, string> = {
  a: "à", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "î", j: "ĵ", k: "ķ", l: "ļ", m: "ɱ",
  n: "ñ", o: "ö", p: "þ", q: "ǫ", r: "ŕ", s: "š", t: "ţ", u: "û", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
  A: "Å", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Î", J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ",
  N: "Ñ", O: "Ö", P: "Þ", Q: "Ǫ", R: "Ŕ", S: "Š", T: "Ţ", U: "Û", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
};

/**
 * In ICU, literal text sits at an even brace depth (the top level and inside a plural or select
 * option); argument names and keywords sit at odd depths. Tags are copied whole.
 */
export function pseudoMessage(message: string): string {
  let out = "";
  let depth = 0;
  let letters = 0;
  for (let i = 0; i < message.length; i++) {
    const ch = message[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "<" && depth % 2 === 0) {
      const end = message.indexOf(">", i);
      if (end > i) {
        out += message.slice(i, end + 1);
        i = end;
        continue;
      }
    } else if (depth % 2 === 0 && ch !== "#" && ACCENTED[ch]) {
      out += ACCENTED[ch];
      letters++;
      continue;
    }
    out += ch;
  }
  return `[${out}${"~".repeat(Math.ceil(letters / 3))}]`;
}

export function pseudoCatalog(english: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(english).map(([key, message]) => [key, pseudoMessage(message)]));
}
