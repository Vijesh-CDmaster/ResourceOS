"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";

export type NavItem = {
  href: string;
  label: string;
  icon:
    | "grid"
    | "cube"
    | "calendar"
    | "check"
    | "wrench"
    | "chart"
    | "settings"
    | "scroll"
    | "plug"
    | "coins"
    | "shield"
    | "box";
  badge?: number;
};

export function AppNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition ${
              active
                ? "bg-white/[0.12] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
                : "text-white/60 hover:bg-white/[0.06] hover:text-white"
            }`}
          >
            <Icon
              name={item.icon}
              className={`h-4 w-4 ${active ? "text-brand-200" : "text-white/40 group-hover:text-white/70"}`}
            />
            <span className="flex-1">{item.label}</span>
            {item.badge ? (
              <span className="rounded-full bg-amber-400/90 px-1.5 py-0.5 text-[10px] font-bold leading-none text-night">
                {item.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function MobileNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto pb-1 lg:hidden">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${
              active
                ? "border-brand-700 bg-brand-700 text-white"
                : "border-line bg-white text-muted"
            }`}
          >
            <Icon name={item.icon} className="h-3.5 w-3.5" />
            {item.label}
            {item.badge ? (
              <span className="rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-night">{item.badge}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
