/** The node settings sections, shared by the settings rail and the page. */
import type { ReactNode } from "react";
import { Archive, Bell, Bot, HardDrive, Info, Palette, Search, ShieldCheck } from "lucide-react";

export type NodeCategory = "ai" | "notifications" | "access" | "storage" | "search" | "backups" | "branding" | "about";

export const NODE_CATEGORIES: Array<{ key: NodeCategory; label: string; icon: ReactNode }> = [
  { key: "ai", label: "AI providers", icon: <Bot size={16} /> },
  { key: "notifications", label: "Notifications", icon: <Bell size={16} /> },
  { key: "access", label: "Access", icon: <ShieldCheck size={16} /> },
  { key: "storage", label: "Storage", icon: <HardDrive size={16} /> },
  { key: "search", label: "Search", icon: <Search size={16} /> },
  { key: "backups", label: "Backups", icon: <Archive size={16} /> },
  { key: "branding", label: "Branding", icon: <Palette size={16} /> },
  { key: "about", label: "About", icon: <Info size={16} /> },
];

/** The default section, and what an unknown :category falls back to. */
export const DEFAULT_NODE_CATEGORY: NodeCategory = "ai";

/** The URL segment is user-typeable; anything unknown falls back to the default. */
export function asNodeCategory(value: string | undefined): NodeCategory {
  return NODE_CATEGORIES.some((c) => c.key === value)
    ? (value as NodeCategory)
    : DEFAULT_NODE_CATEGORY;
}
