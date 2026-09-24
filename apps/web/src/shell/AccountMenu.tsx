/** The avatar menu: who is signed in, their profile, and Sign out. */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Popover } from "@astryxdesign/core/Popover";
import { Avatar } from "@astryxdesign/core/Avatar";
import { List } from "@astryxdesign/core/List";
import { Item } from "@astryxdesign/core/Item";
import { Divider } from "@astryxdesign/core/Divider";
import { Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { LogOut, UserRound } from "lucide-react";
import { Me } from "../api";
import { getDisplayName } from "../lib/http/client";
import { logout } from "../lib/session/tokens";

interface AccountIdentity {
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
    cached ?? { name: getDisplayName(), handle: null },
  );

  useEffect(() => {
    if (cached) return;
    let alive = true;
    inflight ??= Me.whoami()
      .then(({ display_name, alias, username, email }) => {
        cached = { name: display_name || alias, handle: username ? `@${username}` : (email ?? null) };
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
  const { name, handle } = useAccountIdentity();
  const label = name ?? "Account";

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
      label="Account"
      content={
        <VStack gap={0}>
          <HStack gap={2} vAlign="center" padding={3}>
            <Avatar name={label} size="sm" tooltip={false} />
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
              label="Profile"
              startContent={<UserRound size={16} />}
              onClick={() => go("/settings/profile")}
            />
          </List>
          <Divider />
          <List>
            <Item as="li" label="Sign out" startContent={<LogOut size={16} />} onClick={logout} />
          </List>
        </VStack>
      }
    >
      {/* Avatar's own tooltip races this Popover's showPopover() on open. */}
      <button className="account-trigger" aria-label={`Account — ${label}`} title={label}>
        <Avatar name={label} size="sm" tooltip={false} />
      </button>
    </Popover>
  );
}
