// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "@astryxdesign/core/AppShell";
import { mountInto } from "../test/form-input";

vi.mock("./NotificationsBell", () => ({ NotificationsBell: () => null }));
vi.mock("./AccountMenu", () => ({ AccountMenu: () => null }));
vi.mock("./WorkspaceSwitcher", () => ({ WorkspaceSwitcher: () => null }));

const { AppTopNav } = await import("./AppTopNav");
const { CommandPaletteProvider } = await import("./command-palette/context");

const wideScreen = window.matchMedia;

async function render(phone: boolean) {
  window.matchMedia = ((query: string) => ({ ...wideScreen(query), matches: phone && query.startsWith("(width <") })) as typeof window.matchMedia;
  const { host, root } = mountInto();
  await act(async () =>
    root.render(
      <MemoryRouter>
        <CommandPaletteProvider>
          <AppShell topNav={<AppTopNav title="Settings" pageTitle="Profile" />} sideNav={<nav>rail</nav>}>
            <p>page</p>
          </AppShell>
        </CommandPaletteProvider>
      </MemoryRouter>,
    ),
  );
  return host;
}

/** What shows in the bar itself, not in the menu drawer it opens. */
const bar = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-mode="mobile-bar"]') ?? host.querySelector<HTMLElement>("nav")!;

afterEach(() => {
  window.matchMedia = wideScreen;
});

describe("AppTopNav", () => {
  it("keeps the page's name in a phone's bar, with a way into search", async () => {
    const host = await render(true);
    expect(bar(host).querySelector("h1")?.textContent).toBe("Settings");
    expect(bar(host).querySelector('button[aria-label="Search all documents"]')).toBeTruthy();
    expect(document.title).toBe("Profile - Stuga");
  });

  it("leaves search to the ⌘K shortcut on a large screen", async () => {
    const host = await render(false);
    expect(bar(host).querySelector("h1")?.textContent).toBe("Settings");
    expect(bar(host).querySelector('button[aria-label="Search all documents"]')).toBeNull();
  });
});
