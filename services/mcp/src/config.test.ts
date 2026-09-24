import { describe, expect, it } from "vitest";
import { DEFAULT_CLIENT, DEFAULT_URL, DEV_VERSION, parseConfig, readConfigFile, resolveConfig, type StoredConfig } from "./config.js";

function resolve(env: NodeJS.ProcessEnv, sidecar: StoredConfig = {}, home: StoredConfig = {}) {
  return resolveConfig(env, () => sidecar, () => home);
}

describe("parseConfig", () => {
  it("keeps every known string field", () => {
    const all = {
      url: "http://node",
      token: "vk_a_b",
      workspace: "ws-1",
      model: "m-1",
      client: "claude-desktop",
      version: "0.3.0",
      node_name: "Studio",
    };
    expect(parseConfig(all)).toEqual(all);
  });

  it("treats a non-string field as absent", () => {
    expect(parseConfig({ url: 8787, token: "vk_a_b" })).toEqual({ token: "vk_a_b" });
  });

  it("ignores anything that is not an object, and keys it does not know", () => {
    expect(parseConfig(null)).toEqual({});
    expect(parseConfig("vk_a_b")).toEqual({});
    expect(parseConfig({ token: "vk_a_b", proxy: "http://elsewhere" })).toEqual({ token: "vk_a_b" });
  });
});

describe("readConfigFile", () => {
  it("reads a file", () => {
    expect(readConfigFile("/anywhere.json", () => '{"token":"vk_a_b"}')).toEqual({ token: "vk_a_b" });
  });

  it("reads a missing or malformed file as empty", () => {
    const missing = () => {
      throw new Error("ENOENT");
    };
    expect(readConfigFile("/anywhere.json", missing)).toEqual({});
    expect(readConfigFile("/anywhere.json", () => "{ not json")).toEqual({});
  });

  it("accepts a URL", () => {
    const url = new URL("file:///opt/stuga/config.json");
    expect(readConfigFile(url, (p) => (String(p) === url.href ? '{"url":"http://node"}' : "{}"))).toEqual({ url: "http://node" });
  });
});

describe("resolveConfig", () => {
  const side = { url: "http://side", token: "vk_side_1", workspace: "ws-side", model: "side", client: "side-client", version: "0.2.0" };

  it("prefers the environment over both files, key by key", () => {
    const env = {
      STUGA_URL: "http://env",
      STUGA_TOKEN: "vk_env_1",
      STUGA_WORKSPACE: "ws-env",
      STUGA_MODEL: "env-model",
      STUGA_CLIENT: "env-client",
      STUGA_VERSION: "0.4.0",
    } as NodeJS.ProcessEnv;
    expect(resolve(env, side, side)).toEqual({
      url: "http://env",
      token: "vk_env_1",
      workspace: "ws-env",
      model: "env-model",
      client: "env-client",
      version: "0.4.0",
    });
  });

  it("prefers the sidecar over the home file, and falls through for keys it leaves out", () => {
    expect(resolve({}, side, { url: "http://home", token: "vk_home_1" })).toEqual(side);
    expect(resolve({}, { token: "vk_side_1" }, { url: "http://home" })).toMatchObject({ url: "http://home", token: "vk_side_1" });
  });

  it("labels runs and reports the version from the sidecar when the client drops the environment", () => {
    const config = resolve({}, { token: "vk_a_b", client: "claude-desktop", version: "0.3.0" });
    expect(config.client).toBe("claude-desktop");
    expect(config.version).toBe("0.3.0");
  });

  it("takes the node's name from the environment, then the sidecar, and treats a blank one as unset", () => {
    expect(resolve({ STUGA_NODE_NAME: "Studio" }, { node_name: "Old name" }).nodeName).toBe("Studio");
    expect(resolve({}, { token: "vk_a_b", node_name: "Liv’s Mac" }).nodeName).toBe("Liv’s Mac");
    expect(resolve({ STUGA_NODE_NAME: "  " }).nodeName).toBeUndefined();
  });

  it("opens no file once the environment carries both halves of the credential and the node's name", () => {
    const boom = () => {
      throw new Error("a file was read");
    };
    expect(resolveConfig({ STUGA_URL: "http://env", STUGA_TOKEN: "vk_env_1", STUGA_NODE_NAME: "Studio" }, boom, boom)).toEqual({
      url: "http://env",
      token: "vk_env_1",
      workspace: undefined,
      model: undefined,
      client: DEFAULT_CLIENT,
      version: DEV_VERSION,
      nodeName: "Studio",
    });
  });

  it("takes only the node's name from the file beside the server when the environment holds the credential but no name", () => {
    // The extension's launch environment cannot carry a name with `$`, so only its config.json has it.
    const boom = () => {
      throw new Error("the home file was read");
    };
    const env = { STUGA_URL: "http://env", STUGA_TOKEN: "vk_env_1" };
    const sidecar = { url: "http://env", token: "vk_side_1", workspace: "ws-side", client: "side-client", node_name: "Cash $ Office" };
    expect(resolveConfig(env, () => sidecar, boom)).toEqual({
      url: "http://env",
      token: "vk_env_1",
      workspace: undefined,
      model: undefined,
      client: DEFAULT_CLIENT,
      version: DEV_VERSION,
      nodeName: "Cash $ Office",
    });
  });

  it("ignores the name in a file beside the server that belongs to another node", () => {
    const env = { STUGA_URL: "http://env", STUGA_TOKEN: "vk_env_1" };
    expect(resolve(env, { url: "http://elsewhere", node_name: "Elsewhere" }).nodeName).toBeUndefined();
    expect(resolve(env, { node_name: "Nameless" }).nodeName).toBeUndefined();
  });

  it("still consults the files when the environment has only one half", () => {
    expect(resolve({ STUGA_URL: "http://env" }, { token: "vk_side_1" }).token).toBe("vk_side_1");
    expect(resolve({ STUGA_TOKEN: "vk_env_1" }, { url: "http://side" }).url).toBe("http://side");
  });

  it("falls back to the defaults with nothing configured", () => {
    expect(resolve({})).toEqual({ url: DEFAULT_URL, token: "", workspace: undefined, model: undefined, client: DEFAULT_CLIENT, version: DEV_VERSION });
  });

  it("treats a blank version as unset", () => {
    expect(resolve({ STUGA_VERSION: "   " }, { version: "0.3.0" }).version).toBe("0.3.0");
    expect(resolve({ STUGA_VERSION: "   " }).version).toBe(DEV_VERSION);
  });
});
