/** The node settings sections, shared by the settings rail and the page. */
import type { ReactNode } from "react";
import { Archive, Bell, Bot, Globe, HardDrive, Info, Palette, Search, ShieldCheck } from "lucide-react";
import { t } from "../../../i18n/i18n";

export type NodeCategory = "ai" | "notifications" | "access" | "remote" | "storage" | "search" | "backups" | "branding" | "about";

export const NODE_CATEGORIES: Array<{ key: NodeCategory; label: string; icon: ReactNode }> = [
  { key: "ai", label: t("node.categories.ai"), icon: <Bot size={16} /> },
  { key: "notifications", label: t("common.notifications"), icon: <Bell size={16} /> },
  { key: "access", label: t("common.access"), icon: <ShieldCheck size={16} /> },
  // Listed only where the packaging offers it (SettingsLayout).
  { key: "remote", label: t("node.categories.remote"), icon: <Globe size={16} /> },
  { key: "storage", label: t("node.categories.storage"), icon: <HardDrive size={16} /> },
  { key: "search", label: t("node.categories.search"), icon: <Search size={16} /> },
  { key: "backups", label: t("node.categories.backups"), icon: <Archive size={16} /> },
  { key: "branding", label: t("node.categories.branding"), icon: <Palette size={16} /> },
  { key: "about", label: t("node.categories.about"), icon: <Info size={16} /> },
];

/** The default section, and what an unknown :category falls back to. */
export const DEFAULT_NODE_CATEGORY: NodeCategory = "ai";

/** The URL segment is user-typeable; anything unknown falls back to the default. */
export function asNodeCategory(value: string | undefined): NodeCategory {
  return NODE_CATEGORIES.some((c) => c.key === value)
    ? (value as NodeCategory)
    : DEFAULT_NODE_CATEGORY;
}
