import type { SVGProps } from "react";

type IconName =
  | "grid"
  | "cube"
  | "calendar"
  | "check"
  | "wrench"
  | "chart"
  | "settings"
  | "scroll"
  | "bell"
  | "logout"
  | "arrow"
  | "plus"
  | "shield"
  | "clock"
  | "users"
  | "search"
  | "plug"
  | "coins"
  | "box"
  | "clipboard";

const PATHS: Record<IconName, string> = {
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  cube: "M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Zm0 0v18M3 7.5l9 4.5 9-4.5",
  calendar: "M8 2v4M16 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
  check: "M20 6 9 17l-5-5",
  wrench: "M14.7 6.3a4 4 0 0 0 5 5L21 21l-3 .5-9.3-9.3a4 4 0 0 1-5-5L6 4l3.7 3.7",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-3a8 8 0 0 0-.2-1.8l2-1.5-2-3.4-2.3 1a8 8 0 0 0-3-1.7L14 2h-4l-.5 2.6a8 8 0 0 0-3 1.7l-2.3-1-2 3.4 2 1.5A8 8 0 0 0 4 12c0 .6.1 1.2.2 1.8l-2 1.5 2 3.4 2.3-1a8 8 0 0 0 3 1.7L10 22h4l.5-2.6a8 8 0 0 0 3-1.7l2.3 1 2-3.4-2-1.5c.1-.6.2-1.2.2-1.8Z",
  scroll: "M8 3h11a2 2 0 0 1 2 2v13a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-2h5M8 3v13a3 3 0 0 1-3 3M8 3H5a2 2 0 0 0-2 2v9M11 8h6M11 12h6",
  bell: "M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.7 21a2 2 0 0 1-3.4 0",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  arrow: "M5 12h14M13 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  shield: "M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6l-8-3Zm0 5v5m0 3h.01",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-14v5l3 2",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm14 10v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.3-4.3",
  plug: "M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v5",
  coins: "M9 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm6-9.7A5 5 0 0 1 16 14a6 6 0 0 1-8 8 5 5 0 0 1-3-9.9M9 8h.01M9 11V8",
  box: "M4 8h16v12H4zM4 8l2-4h12l2 4M9 12h6",
  clipboard: "M9 4h6v3H9zM9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3M8 12h8M8 16h5",
};

export function Icon({
  name,
  className = "h-4 w-4",
  ...props
}: { name: IconName; className?: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-500 text-night shadow-sm">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
          <path d="M4 19V7l5-3v15M9 19h11V11l-6-3v11" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
          <path d="M12 13h3M12 16h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>
      {!compact ? (
        <span className="leading-tight">
          <span className="block text-[15px] font-semibold tracking-tight">ResourceOS</span>
          <span className="block text-[10px] font-medium uppercase tracking-[0.16em] text-white/45">
            Facility control
          </span>
        </span>
      ) : null}
    </div>
  );
}
