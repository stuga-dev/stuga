/**
 * Where a link someone makes for another person opens (GET /api/link-addresses): on this node's
 * network, or anywhere, through the remote address while it is on. The invite and password link
 * dialogs share this switch and the line under a new link that says who can open it.
 */
import { useEffect, useState } from "react";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { Me, type LinkAddresses } from "../api";
import { t } from "../i18n/i18n";

export type LinkAddress = LinkAddresses["default"];

/** The addresses a link can point at, read once `active` turns true; null until then, or when they could not be read. */
export function useLinkAddresses(active: boolean): LinkAddresses | null {
  const [addresses, setAddresses] = useState<LinkAddresses | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    Me.linkAddresses()
      .then((a) => live && setAddresses(a))
      .catch(() => live && setAddresses(null));
    return () => {
      live = false;
    };
  }, [active]);
  return addresses;
}

/** The two-way switch, while the remote address is on; nothing otherwise. */
export function LinkAddressSwitch({
  addresses,
  value,
  onChange,
  isDisabled,
}: {
  addresses: LinkAddresses | null;
  value: LinkAddress;
  onChange: (next: LinkAddress) => void;
  isDisabled?: boolean;
}) {
  if (!addresses?.remote) return null;
  return (
    <SegmentedControl label={t("ui.linkAddress.label")} value={value} onChange={(v) => onChange(v as LinkAddress)} isDisabled={isDisabled}>
      <SegmentedControlItem value="local" label={addresses.local === "computer" ? t("ui.linkAddress.thisComputer") : t("ui.linkAddress.thisNetwork")} />
      <SegmentedControlItem value="remote" label={t("ui.linkAddress.anywhere")} />
    </SegmentedControl>
  );
}

/**
 * Who can open a link that was just made, under it: only this computer when the node's own address
 * is this computer's (PUBLIC_ORIGIN on loopback), other devices on its network, or any device
 * through the remote address. Null until the addresses are known.
 */
export function linkReachNote(addresses: LinkAddresses | null, address: LinkAddress): string | null {
  if (!addresses) return null;
  if (address === "remote") return t("ui.linkAddress.opensAnywhere");
  return addresses.local === "computer" ? t("ui.linkAddress.onlyComputer") : t("ui.linkAddress.onlyNetwork");
}

export function LinkReachNote({ addresses, address }: { addresses: LinkAddresses | null; address: LinkAddress }) {
  const note = linkReachNote(addresses, address);
  return note ? (
    <Text size="sm" color="secondary">
      {note}
    </Text>
  ) : null;
}
