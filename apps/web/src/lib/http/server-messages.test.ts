/**
 * Each sentence in SERVER_MESSAGES must still be one the node sends: its `from` file has to hold
 * it as a string (or, for a pattern, templates with the same static text) inside an error(),
 * fail() or json() call, a refusal, or the `error`/`message` field of an answer. A reworded node
 * sentence fails here instead of quietly reading in English.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite";
import { describe, expect, it } from "vitest";
import { failureFrom } from "./client";
import { presentServerMessage, SERVER_MESSAGES } from "./server-messages";

const nodeSrc = fileURLToPath(new URL("../../../../../services/node/src/", import.meta.url));

/** Calls whose arguments are an error response: error(), fail(), json(), refuse(), and refusals and errors built with a status. */
const ERROR_CALLS = /^(error|fail|json|refuse)$|(Error|Refusal)$/;
/** Fields of an answer or a refusal that carry its sentence. */
const ERROR_FIELDS = new Set(["error", "message"]);

/**
 * Sentences the node keeps in a constant, a record or a helper's return value before a route
 * sends them, and text it sends outside an error body that the app shows as it arrives. Each
 * still has to be in its `from` file.
 */
const SENT_OTHERWISE = new Set<string>([
  // http/serving-gate.ts: the status a paused node answers with, from the notify catalog it renders
  "Stuga is starting.",
  "Stuga is backing up before an upgrade.",
  "Stuga is upgrading.",
  "Stuga is making a backup.",
  // config/env.ts: hints shown beside a setting or a newer version
  "Restart the node to apply.",
  "Upgrade on the machine that runs the node.",
  // constants a refusal quotes
  "From outside this network, sign in with a passkey or a password of 15 characters or more that is hard to guess.",
  "Use 2–32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.",
  "default_doc_access must be workspace_edit | workspace_view | private",
  // remote/service.ts: CODE_REFUSALS
  "That code isn't valid.",
  "That code has already been used.",
  "That code has expired.",
  "Remote access is off for this address.",
  // helpers that return the reason a route then refuses with
  "the node is waiting to back up; try again once it has",
  "a backup is already under way",
  "the name must contain a visible character",
  "^the (client ID) cannot contain control characters$",
  "^the (button label) cannot contain control characters$",
  "^the (scopes) cannot contain control characters$",
  "^the (name) cannot contain control characters$",
  "an SMTP URL is required to deliver by email",
  "a From address is required to deliver by email",
  "^a webhook URL is required to deliver to (.+)$",
  // databases/imports/staging.ts: the 422 report's message, passed to failure()
  "the file's headers do not match the table; nothing was loaded",
  "^(\\d+) of (\\d+) rows failed validation; nothing was loaded$",
  "^(\\d+) rows failed validation, more than max_bad_rows \\((\\d+)\\); nothing was loaded$",
  // databases/routes.ts: proxyActor's fallbacks
  "could not add the column",
  "could not change the column type",
  "could not change the view",
  "could not create the table",
  "could not create the view",
  "could not delete the column",
  "could not delete the table",
  "could not delete the view",
  "could not describe the column",
  "could not load activity",
  "could not rename the column",
  "could not rename the table",
  "could not revert",
  "query failed",
  // the database actor's conflict() and requireUnlocked() sentences, and its locked constant
  "a column this change writes no longer exists — the schema changed after the change was made",
  "none of the proposed rows exist any more",
  "a column this view refers to no longer exists — the schema changed after the change was made",
  "this view was already created",
  "this table was already created",
  "this column was already added",
  "this database is locked; unlock it to make changes",
  "this database is locked; unlock it to review changes",
  "this database is locked; unlock it to revert changes",
  // net/outbound.ts: the reason vetOutboundUrl returns, which the webhook routes refuse with
  "refusing to reach a private or loopback address",
  "^not a valid absolute URL: (.+)$",
  "^unsupported URL scheme \"(.*)\" — use http\\(s\\)$",
  "^could not resolve \"(.*)\"$",
  // jobs/sinks.ts: UNSENT_ENGLISH, and SinkAnsweredError's message, which the notification test answers with
  "email is not set up",
  "you have no email address in Stuga",
  "no webhook URL is set",
  "no sink is set up",
  "^notification sink answered (\\d+)$",
  // boot/boot.ts, ops/node-backups.ts and ops/backup.ts: why a backup waits or failed, recorded for the backups page
  "a workspace is being imported or exported",
  "^still waiting after (\\d+) hours: (.+)$",
  "^not enough disk at (.+): about (.+) needed, (.+) free\\. A dump that runs out of space can look complete and not restore\\. Nothing was changed\\.$",
  "^writing the backup failed: (.+)\\. Your data is untouched\\.$",
  "^the dump did not read back \\((.+)\\);\\sno backup was kept\\. Your data is untouched\\.$",
  "^the archive did not read back \\((.+)\\);\\sno backup was kept\\. Your data is untouched\\.$",
  "^the backup failed: (.+)\\. Your data is untouched\\.$",
  "^another backup or restore of database \"(.*)\" is running; nothing was changed$",
  "^this node no longer holds database \"(.*)\"; nothing was changed$",
  "^(.+) already exists; nothing was changed$",
  "^this node lost its hold on database \"(.*)\" while the backup ran, so nothing proves it was the only writer;\\sno backup was kept\\. Your data is untouched\\.$",
  "^this backup's hold on database \"(.*)\" ended while it ran \\(Postgres restarted, or the connection dropped\\),\\sso nothing proves the node stayed stopped throughout;\\sno backup was kept\\. Your data is untouched\\.$",
]);

interface Site {
  text: string;
  inErrorCall: boolean;
}

interface AstNode {
  type: string;
  [key: string]: unknown;
}

const sitesCache = new Map<string, Site[]>();

function calleeName(node: AstNode): string | null {
  const callee = node.callee as AstNode | undefined;
  if (!callee) return null;
  if (callee.type === "Identifier") return callee.name as string;
  if (callee.type === "MemberExpression") return ((callee.property as AstNode).name as string) ?? null;
  return null;
}

function propertyName(key: AstNode): string {
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return "";
}

/** Every string and template in a node file, and whether an error()/fail()/json() call holds it; a JSON catalog's messages. */
function sitesIn(from: string): Site[] {
  const cached = sitesCache.get(from);
  if (cached) return cached;
  const path = join(nodeSrc, from);
  if (from.endsWith(".json")) {
    const catalog = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const messages = Object.values(catalog).filter((v): v is string => typeof v === "string");
    const sites = messages.map((text) => ({ text, inErrorCall: false }));
    sitesCache.set(from, sites);
    return sites;
  }
  const { program } = parseSync(path, readFileSync(path, "utf8"), { lang: "ts" });
  const sites: Site[] = [];
  const walk = (node: unknown, inErrorCall: boolean): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, inErrorCall);
      return;
    }
    if (!node || typeof node !== "object") return;
    const n = node as AstNode;
    if (n.type === "Literal" && typeof n.value === "string") sites.push({ text: n.value, inErrorCall });
    if (n.type === "TemplateLiteral") {
      const quasis = n.quasis as { value: { cooked: string | null } }[];
      // A NUL where each value goes, so no static text spans one.
      sites.push({ text: quasis.map((q) => q.value.cooked ?? "").join("\u0000"), inErrorCall });
    }
    const inside = inErrorCall || ((n.type === "CallExpression" || n.type === "NewExpression") && ERROR_CALLS.test(calleeName(n) ?? ""));
    if (n.type === "Property" && ERROR_FIELDS.has(propertyName(n.key as AstNode))) {
      walk(n.value, true);
      return;
    }
    for (const [key, value] of Object.entries(n)) {
      if (key !== "type" && typeof value === "object") walk(value, inside);
    }
  };
  walk(program, false);
  sitesCache.set(from, sites);
  return sites;
}

/**
 * The plain text of a pattern outside its groups, cut at each value and each sentence end: what
 * the node's templates say verbatim. A sentence built from two templates has a piece in each.
 */
function staticTexts(pattern: RegExp): string[] {
  const src = pattern.source;
  const runs: string[] = [];
  let run = "";
  const end = () => {
    if (run) runs.push(run);
    run = "";
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      const next = src[++i]!;
      if ("dDsSwWbB".includes(next)) end();
      else run += next;
    } else if (c === "(") {
      end();
      let depth = 1;
      while (depth > 0 && ++i < src.length) {
        if (src[i] === "\\") i++;
        else if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
      }
    } else if ("?*+{".includes(c)) {
      run = run.slice(0, -1);
      end();
      if (c === "{") while (i < src.length && src[i] !== "}") i++;
    } else if (c === "[") {
      end();
      while (i < src.length && src[i] !== "]") i++;
    } else if (c === "^" || c === "$" || c === "." || c === "|") {
      end();
    } else {
      run += c;
    }
  }
  end();
  return runs.flatMap((r) => r.split(/(?<=\. )/)).filter((r) => r.trim().length > 3);
}

const label = (match: string | RegExp) => (typeof match === "string" ? match : match.source);

describe("SERVER_MESSAGES", () => {
  it.each(SERVER_MESSAGES.map((entry) => [label(entry.match), entry] as const))("%s is still sent by the node", (_, entry) => {
    const sites = sitesIn(entry.from);
    const found: Site[] = [];
    if (typeof entry.match === "string") {
      found.push(...sites.filter((s) => s.text === entry.match));
    } else {
      const pieces = staticTexts(entry.match);
      expect(pieces, `${label(entry.match)} has static text`).not.toHaveLength(0);
      for (const piece of pieces) {
        const holding = sites.filter((s) => s.text.includes(piece.trim()));
        expect(holding, `“${piece}” of ${label(entry.match)} in ${entry.from}`).not.toHaveLength(0);
        found.push(...holding);
      }
    }
    expect(found, `${label(entry.match)} in ${entry.from}`).not.toHaveLength(0);
    if (!SENT_OTHERWISE.has(label(entry.match))) {
      expect(
        found.some((s) => s.inErrorCall),
        `${label(entry.match)} inside error()/fail()/json() in ${entry.from}`,
      ).toBe(true);
    }
  });

  it("matches each sentence once", () => {
    const sentences = SERVER_MESSAGES.map((e) => e.match).filter((m): m is string => typeof m === "string");
    expect(new Set(sentences).size).toBe(sentences.length);
    const keys = SERVER_MESSAGES.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("lists only entries it has under SENT_OTHERWISE", () => {
    const labels = new Set(SERVER_MESSAGES.map((e) => label(e.match)));
    expect([...SENT_OTHERWISE].filter((l) => !labels.has(l))).toEqual([]);
  });
});

describe("presentServerMessage", () => {
  it("maps known sentences to the catalog", () => {
    expect(presentServerMessage("not found")).toBe("Not found.");
    expect(presentServerMessage("this invite link is invalid, expired, or fully used")).toBe(
      "This invite link is invalid, expired, or fully used.",
    );
    expect(presentServerMessage("A link with no limit or no expiry can be made only on this node's network.")).toBe(
      "A link with no limit or no expiry can be made only on this node’s network.",
    );
  });

  it("fills in the values of a sentence that carries them", () => {
    expect(presentServerMessage("password must be at least 12 characters")).toBe("Password must be at least 12 characters.");
    expect(presentServerMessage("Too many wrong passwords. Try again in 1 minute.")).toBe(
      "Too many wrong passwords. Try again in 1 minute.",
    );
    expect(presentServerMessage("Too many failed sign-ins. Try again in 5 minutes.")).toBe(
      "Too many failed sign-ins. Try again in 5 minutes.",
    );
    expect(presentServerMessage("No account matches @liv. Send them an invite link instead.")).toBe(
      "No account matches @liv. Send them an invite link instead.",
    );
  });

  it("presents the sentence inside a sentence in the catalog's words too", () => {
    expect(presentServerMessage("still waiting after 3 hours: a workspace is being imported or exported")).toBe(
      "Still waiting after 3 hours: A workspace is being imported or exported.",
    );
    expect(presentServerMessage('column "Due": expected YYYY-MM-DD')).toBe("Column “Due”: Enter a date as YYYY-MM-DD.");
    expect(presentServerMessage('column "Due": expected YYYY-MM-DD (the schema changed after the change was made)')).toBe(
      "The schema changed after the change was made. Column “Due”: Enter a date as YYYY-MM-DD.",
    );
  });

  it("reads the probe's prefixed sentence as the settings check's", () => {
    const bare = "the anthropic provider serves no embeddings endpoint; point embed at an OpenAI-compatible or Ollama endpoint";
    expect(presentServerMessage(`embed: ${bare}`)).toBe(presentServerMessage(bare));
    expect(presentServerMessage(bare)).not.toBe(bare);
  });

  it("returns a sentence it does not know as sent", () => {
    expect(presentServerMessage("the flux capacitor is out of alignment")).toBe("the flux capacitor is out of alignment");
    expect(presentServerMessage("")).toBe("");
  });
});

describe("failureFrom", () => {
  it("presents the node's sentence and keeps its raw text as the code", () => {
    const err = failureFrom("/api/x", "GET", 404, { error: "not found" });
    expect(err.message).toBe("Not found.");
    expect(err.code).toBe("not found");
    expect(err.status).toBe(404);
  });

  it("prefers the message of a coded refusal", () => {
    const err = failureFrom("/api/x", "POST", 403, { error: "password_off_network", message: "unknown words" });
    expect(err.message).toBe("unknown words");
    expect(err.code).toBe("password_off_network");
  });

  it("asks for a confirmation in the catalog's words", () => {
    const err = failureFrom("/api/x", "POST", 401, { error: "reauth_required", methods: ["password", 3] });
    expect(err.message).toBe("Confirm it’s you to continue.");
    expect(err.methods).toEqual(["password"]);
  });

  it("falls back to generic prose without a body", () => {
    expect(failureFrom("/api/x", "GET", 502, null).message).toBe(
      "The server isn’t responding right now. That didn’t go through — try again in a moment.",
    );
    expect(failureFrom("/api/x", "GET", 404, null).message).toBe("That isn’t here any more.");
  });
});
