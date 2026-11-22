import { Compass, ListChecks, Settings, type LucideIcon } from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon };

export const NAV_ITEMS: NavItem[] = [
  { href: "/discover", label: "Discover", icon: Compass },
  { href: "/pipeline", label: "Pipeline", icon: ListChecks },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function isActivePath(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
