/** The avatar menu: who is signed in, their profile, the keyboard shortcuts, where to get help, and Sign out. */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Popover } from "@astryxdesign/core/Popover";
import { List } from "@astryxdesign/core/List";
import { Item } from "@astryxdesign/core/Item";
import { Divider } from "@astryxdesign/core/Divider";
import { Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Keyboard, LifeBuoy, LogOut, UserRound } from "lucide-react";
import { openKeyboardShortcuts } from "./KeyboardShortcuts";
import { Me } from "../api";
import { Avatar, principalName, rememberUsers, useNamesVersion } from "../state/identity";
import { getDisplayName } from "../lib/http/client";
import { logout } from "../lib/session/tokens";
import { t } from "../i18n/i18n";

// A plain link: the node sends nothing to us, so help starts from the person.
const DISCUSSIONS_URL = "https://github.com/stuga-dev/stuga/discussions";

interface AccountIdentity {
  /** Null until whoami answers; the names cache then carries the name, renamed or not. */
  alias: string | null;
  name: string | null;
  /** `@username` on a node with its own accounts, else the provider's email; null when there is neither. */
  handle: string | null;
}

let cached: AccountIdentity | null = null;
let inflight: Promise<void> | null = null;

/**
 * Fetched once per page load, since every TopNav renders this menu. The display
 * name from response headers seeds it, but is null until the first authed response.
 */
function useAccountIdentity(): AccountIdentity {
  const [identity, setIdentity] = useState<AccountIdentity>(
    cached ?? { alias: null, name: getDisplayName(), handle: null },
  );

  useEffect(() => {
    if (cached) return;
    let alive = true;
    inflight ??= Me.whoami()
      .then(({ display_name, alias, username, email }) => {
        cached = { alias, name: display_name || alias, handle: username ? `@${username}` : (email ?? null) };
        rememberUsers([{ alias, username, display_name, email }]);
      })
      .catch(() => {});
    void inflight.then(() => {
      if (alive && cached) setIdentity(cached);
    });
    return () => {
      alive = false;
    };
  }, []);

  return identity;
}

export function AccountMenu() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const { alias, name, handle } = useAccountIdentity();
  // Read through the names cache, so a rename shows here at once.
  useNamesVersion();
  const label = (alias ? principalName(`user:${alias}`) : name) ?? t("shell.account.label");
  const principal = `user:${alias ?? ""}`;

  function go(to: string) {
    setOpen(false);
    nav(to);
  }

  return (
    <Popover
      isOpen={open}
      onOpenChange={setOpen}
      placement="below"
      alignment="end"
      width={260}
      label={t("shell.account.label")}
      content={
        <VStack gap={0}>
          <HStack gap={2} vAlign="center" padding={3}>
            <Avatar principal={principal} name={label} size={32} />
            <VStack gap={0}>
              <Text weight="semibold" maxLines={1}>
                {label}
              </Text>
              {handle && (
                <Text size="sm" color="secondary" maxLines={1}>
                  {handle}
                </Text>
              )}
            </VStack>
          </HStack>
          <Divider />
          <List>
            {/* Settings has its one entry in the sidebar; this is the shortcut to your own part of it. */}
            <Item
              as="li"
              label={t("shell.account.profile")}
              startContent={<UserRound size={16} />}
              onClick={() => go("/settings/profile")}
            />
          </List>
          <Divider />
          <List>
            <Item
              as="li"
              label={t("shell.shortcuts.title")}
              startContent={<Keyboard size={16} />}
              onClick={() => {
                setOpen(false);
                openKeyboardShortcuts();
              }}
            />
            <Item
              as="li"
              label={t("shell.account.help")}
              startContent={<LifeBuoy size={16} />}
              href={DISCUSSIONS_URL}
              target="_blank"
            />
          </List>
          <Divider />
          <List>
            <Item as="li" label={t("shell.account.signOut")} startContent={<LogOut size={16} />} onClick={logout} />
          </List>
        </VStack>
      }
    >
      {/* Avatar's own tooltip races this Popover's showPopover() on open. */}
      <button className="account-trigger" aria-label={t("shell.account.trigger", { name: label })} title={label}>
        <Avatar principal={principal} name={label} size={32} />
      </button>
    </Popover>
  );
}
