import Link from "next/link";
import type { ReactNode } from "react";
import type { SessionUser } from "@/lib/auth";
import { ROLE_LABEL } from "@/lib/roles";
import { logoutAction } from "@/app/login/actions";
import { AppNav, MobileNav, type NavItem } from "./app-nav";
import { Icon, Logo } from "./icons";

function initials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function AppShell({
  user,
  departmentName,
  pendingCount,
  unreadCount,
  children,
}: {
  user: SessionUser;
  departmentName: string | null;
  pendingCount: number;
  unreadCount: number;
  children: ReactNode;
}) {
  const items: NavItem[] = [
    { href: "/dashboard", label: "Dashboard", icon: "grid" },
    { href: "/resources", label: "Resources", icon: "cube" },
    { href: "/bookings", label: "My bookings", icon: "calendar" },
  ];
  if (user.role === "admin" || user.role === "manager") {
    items.push({ href: "/approvals", label: "Approvals", icon: "check", badge: pendingCount });
  }
  if (user.role !== "member") {
    items.push({ href: "/operations", label: "Operations", icon: "wrench" });
    items.push({ href: "/capital", label: "Capital", icon: "coins" });
    items.push({ href: "/reports", label: "Reports", icon: "chart" });
  }
  if (user.role === "admin" || user.role === "manager") {
    items.push({ href: "/integrations", label: "Integrations", icon: "plug" });
  }
  if (user.role === "admin") {
    items.push({ href: "/admin", label: "Administration", icon: "settings" });
  }
  if (user.role !== "member") {
    items.push({ href: "/audit", label: "Audit trail", icon: "scroll" });
  }

  const today = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());

  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-night px-3.5 py-5 lg:flex">
        <div className="px-2 text-white">
          <Logo />
        </div>

        <div className="mt-7 px-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/35">Workspace</p>
          <p className="mt-1 truncate text-[13px] font-medium text-white/85">{user.organizationName}</p>
        </div>

        <div className="mt-5 flex-1 overflow-y-auto">
          <AppNav items={items} />
        </div>

        <div className="mt-4 rounded-xl bg-white/[0.05] p-3">
          <Link href="/dashboard#notifications" className="flex items-center gap-2 text-white/70 hover:text-white">
            <Icon name="bell" className="h-4 w-4" />
            <span className="text-xs font-medium">Notifications</span>
            {unreadCount > 0 ? (
              <span className="ml-auto rounded-full bg-brand-500 px-1.5 py-0.5 text-[10px] font-bold text-night">
                {unreadCount}
              </span>
            ) : null}
          </Link>
        </div>

        <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-white/10 p-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-500/90 text-[11px] font-bold text-night">
            {initials(user.name)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-semibold text-white">{user.name}</p>
            <p className="truncate text-[10px] text-white/45">
              {ROLE_LABEL[user.role]}
              {departmentName ? ` · ${departmentName}` : ""}
            </p>
          </div>
          <form action={logoutAction}>
            <button
              type="submit"
              title="Sign out"
              className="rounded-md p-1.5 text-white/45 transition hover:bg-white/10 hover:text-white"
            >
              <Icon name="logout" className="h-4 w-4" />
              <span className="sr-only">Sign out</span>
            </button>
          </form>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 px-4 py-3 backdrop-blur md:px-8 lg:py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 lg:hidden">
              <span className="rounded-lg bg-night px-2 py-1.5 text-white">
                <Logo compact />
              </span>
              <span className="text-sm font-semibold text-ink">ResourceOS</span>
            </div>
            <div className="hidden text-xs text-muted lg:block">
              <span className="font-medium text-ink/80">{user.organizationName}</span>
              <span className="mx-2 text-line">/</span>
              {today}
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/dashboard#notifications"
                className="relative rounded-lg border border-line bg-white p-2 text-muted transition hover:text-ink"
                aria-label="Notifications"
              >
                <Icon name="bell" className="h-4 w-4" />
                {unreadCount > 0 ? (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[9px] font-bold text-white">
                    {unreadCount}
                  </span>
                ) : null}
              </Link>
              <span className="hidden rounded-lg border border-line bg-white px-3 py-2 text-xs font-medium text-ink sm:block">
                {user.name.split(" ")[0]} · {ROLE_LABEL[user.role]}
              </span>
              <form action={logoutAction} className="lg:hidden">
                <button
                  type="submit"
                  className="rounded-lg border border-line bg-white p-2 text-muted transition hover:text-ink"
                  aria-label="Sign out"
                >
                  <Icon name="logout" className="h-4 w-4" />
                </button>
              </form>
            </div>
          </div>
          <div className="mt-3 lg:hidden">
            <MobileNav items={items} />
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
