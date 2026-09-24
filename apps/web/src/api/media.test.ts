// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession, getToken } from "../lib/session/tokens";
import { getActiveWorkspace, setActiveWorkspace } from "../lib/session/workspace-pointer";
import { Media } from "./media";

/** An XMLHttpRequest that records what was sent and answers with `reply`. */
class FakeXhr {
  static last: FakeXhr | null = null;
  static reply: { status: number; body: string; headers?: Record<string, string> } = { status: 200, body: "{}" };
  headers: Record<string, string> = {};
  method = "";
  url = "";
  status = 0;
  responseText = "";
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  getResponseHeader(name: string): string | null {
    return FakeXhr.reply.headers?.[name.toLowerCase()] ?? null;
  }
  send(): void {
    queueMicrotask(() => {
      this.status = FakeXhr.reply.status;
      this.responseText = FakeXhr.reply.body;
      this.onload?.();
    });
  }
  abort(): void {
    this.onabort?.();
  }
}

const file = () => new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  setSession({ accessToken: "at-1", expiresIn: 3600 });
  setActiveWorkspace("ws-second");
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXhr.last = null;
  FakeXhr.reply = { status: 200, body: "{}" };
});

describe("Media.uploadWithProgress", () => {
  it("sends the bearer and the active workspace, like every other request", async () => {
    FakeXhr.reply = { status: 201, body: JSON.stringify({ url: "/api/docs/d1/media/h1", hash: "h1" }) };
    const progress: number[] = [];
    const result = await Media.uploadWithProgress("d1", file(), (f) => progress.push(f));
    expect(FakeXhr.last?.url).toBe("/api/docs/d1/media");
    expect(FakeXhr.last?.headers.authorization).toBe("Bearer at-1");
    expect(FakeXhr.last?.headers["x-stuga-workspace"]).toBe("ws-second");
    expect(result).toEqual({ url: "/api/docs/d1/media/h1", hash: "h1" });
    expect(progress.at(-1)).toBe(1);
  });

  it("rejects with the server's own message and status", async () => {
    FakeXhr.reply = { status: 413, body: JSON.stringify({ error: "That image is larger than 10 MB." }) };
    await expect(Media.uploadWithProgress("d1", file(), () => {})).rejects.toMatchObject({
      message: "That image is larger than 10 MB.",
      status: 413,
    });
  });

  it("ends the session on a 401, as any other request does", async () => {
    FakeXhr.reply = { status: 401, body: JSON.stringify({ error: "unauthorized" }) };
    await expect(Media.uploadWithProgress("d1", file(), () => {})).rejects.toMatchObject({ status: 401 });
    expect(getToken()).toBeNull();
    expect(getActiveWorkspace()).toBeNull();
  });
});
