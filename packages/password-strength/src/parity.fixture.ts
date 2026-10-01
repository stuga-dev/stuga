/** Inputs and the result they score, checked in Node (node.test.ts) and in a browser (jsdom.test.ts) alike. */
export const PARITY_INPUTS = { username: "bo", nodeName: "North Office" };
export const PARITY: ReadonlyArray<readonly [password: string, ok: boolean, score: number | null]> = [
  ["short", false, null],
  ["password1234567", false, 1],
  ["qwertyuiopasdfgh", false, 1],
  ["aaaaaaaaaaaaaaaa", false, 0],
  ["trumpet walnut ceiling", true, 4],
];
