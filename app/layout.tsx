import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ResourceOS — Facility booking control loop",
  description:
    "Tenant-isolated booking, approvals, maintenance and utilization reporting for shared institutional facilities.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
