/**
 * One pool per connection string per process, shared by every caller. The
 * shared client's `end()` does nothing; only `closeClients` closes pools.
 */
import postgres, { type Notice, type Sql } from "postgres";

export type { Sql };

const clients = new Map<string, { raw: Sql; shared: Sql }>();

const noopEnd = async (): Promise<void> => {};

/**
 * Lift libpq-style `?host=`, `?port=` and `?user=` out of a URL into options:
 * postgres.js would send them to the server as startup parameters, and a socket
 * directory has to be able to travel in DATABASE_URL alone.
 */
export function pgConnection(connectionString: string): { url: string; options: { host?: string; port?: number; user?: string } } {
  const q = connectionString.indexOf("?");
  if (q < 0) return { url: connectionString, options: {} };
  const params = new URLSearchParams(connectionString.slice(q + 1));
  const options: { host?: string; port?: number; user?: string } = {};
  const host = params.get("host");
  const port = params.get("port");
  const user = params.get("user");
  if (host) options.host = host;
  if (port) options.port = Number(port);
  if (user) options.user = user;
  for (const name of ["host", "port", "user"]) params.delete(name);
  const rest = params.toString();
  return { url: connectionString.slice(0, q) + (rest ? `?${rest}` : ""), options };
}

/**
 * A server notice as one log line. pg_search's planner warnings are dropped: they
 * only say that a faster plan did not apply, and repeat on every such query.
 */
export function logNotice(notice: Notice): void {
  if (notice.code === "01000" && /^pg_search::(\w+::)*planner_warnings::/.test(notice.routine ?? "")) return;
  console.warn(`[postgres] ${notice.severity}: ${notice.message}`);
}

function open(connectionString: string): Sql {
  const { url, options } = pgConnection(connectionString);
  return postgres(url, {
    ...options,
    max: 10,
    // Required: without the type OIDs a JS array bound to a text[] parameter is
    // sent as a comma-joined string, which Postgres rejects.
    fetch_types: true,
    idle_timeout: 60,
    connect_timeout: 10,
    onnotice: logNotice,
    types: {
      // int8 reads as a Number: every int8 column is a counter far below 2^53, and
      // a BigInt would not survive JSON. Cast a larger value to ::text in its query.
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number | bigint | string) => x.toString(),
        parse: (x: string) => Number(x),
      },
    },
  });
}

/** The shared pooled client for `connectionString`; its `end()` does nothing. */
export function createClient(connectionString: string): Sql {
  const existing = clients.get(connectionString);
  if (existing) return existing.shared;
  const raw = open(connectionString);
  // A Proxy, because `sql` is itself callable and everything else must pass through.
  const shared = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === "end") return noopEnd;
      return Reflect.get(target, prop, receiver);
    },
    apply(target, _thisArg, args) {
      return Reflect.apply(target, undefined, args);
    },
  });
  clients.set(connectionString, { raw, shared });
  return shared;
}

/** Close every pool this process opened: the shutdown path and test teardown only. */
export async function closeClients(opts: { timeout?: number } = {}): Promise<void> {
  const open = [...clients.values()];
  clients.clear();
  await Promise.all(open.map((c) => c.raw.end({ timeout: opts.timeout ?? 5 }).catch(() => {})));
}
