/**
 * Where a link someone makes for another person opens (GET /api/link-addresses): on this node's
 * network, or anywhere, through the remote address while it is on. The invite and password link
 * dialogs share this switch and the line under a link that opens only nearby.
 */
import { useEffect, useState } from "react";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { Me, type LinkAddresses } from "../api";

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
    <SegmentedControl label="Who the link is for" value={value} onChange={(v) => onChange(v as LinkAddress)} isDisabled={isDisabled}>
      <SegmentedControlItem value="local" label={addresses.local === "computer" ? "For someone on this computer" : "For someone on this network"} />
      <SegmentedControlItem value="remote" label="For someone anywhere" />
    </SegmentedControl>
  );
}

/** "Opens only on this network." under a link to the node's own address, when that is not obvious. */
export function localOnlyNote(addresses: LinkAddresses | null, address: LinkAddress): string | null {
  if (!addresses || address !== "local") return null;
  if (addresses.local === "computer") return "Opens only on this computer.";
  return addresses.remote ? "Opens only on this network." : null;
}

export function LocalOnlyNote({ addresses, address }: { addresses: LinkAddresses | null; address: LinkAddress }) {
  const note = localOnlyNote(addresses, address);
  return note ? (
    <Text size="sm" color="secondary">
      {note}
    </Text>
  ) : null;
}
