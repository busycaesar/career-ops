"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/cn";
import { instrumentSerif } from "@/lib/fonts";
import { NAV_ITEMS, isActivePath } from "@/lib/nav-items";

const SIDEBAR_HIDDEN_KEY = "web2.sidebar-hidden";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    try {
      setHidden(localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "1");
    } catch {
      // Storage can be blocked (private window); the bar then just starts visible.
    }
  }, []);

  function toggle() {
    const next = !hidden;
    setHidden(next);
    try {
      localStorage.setItem(SIDEBAR_HIDDEN_KEY, next ? "1" : "0");
    } catch {
      // Not remembered across reloads when storage is blocked; the toggle still works.
    }
  }

  return (
    <div className="flex min-h-screen">
      {!hidden && (
        <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface/30 p-4">
          <div className="mb-8 flex items-center justify-between px-1">
            <Link href="/discover">
              <span className={`${instrumentSerif.className} text-2xl tracking-tight text-landing`}>career-ops</span>
            </Link>
            <button
              type="button"
              onClick={toggle}
              aria-label="Hide sidebar"
              title="Hide sidebar"
              className="rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-foreground"
            >
              <PanelLeftClose className="size-4" />
            </button>
          </div>
          <nav className="flex flex-col gap-1">
            {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                  isActivePath(href, pathname)
                    ? "bg-brand-soft text-brand-text"
                    : "text-muted hover:bg-surface-hover hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {label}
              </Link>
            ))}
          </nav>
        </aside>
      )}
      <main className="relative flex-1 overflow-x-hidden">
        {hidden && (
          <button
            type="button"
            onClick={toggle}
            aria-label="Show sidebar"
            title="Show sidebar"
            className="absolute left-3 top-3 z-10 rounded-md border border-border bg-surface p-1.5 text-muted hover:bg-surface-hover hover:text-foreground"
          >
            <PanelLeftOpen className="size-4" />
          </button>
        )}
        {children}
      </main>
    </div>
  );
}
