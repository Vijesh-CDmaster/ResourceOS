import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { Logo } from "@/components/icons";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in — ResourceOS" };

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/dashboard");

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden bg-night px-12 py-10 text-white lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 top-10 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -left-20 h-96 w-96 rounded-full bg-brand-900/60 blur-3xl"
        />
        <Logo />

        <div className="relative max-w-lg">
          <p className="mb-4 inline-flex rounded-full border border-white/15 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-brand-200">
            Facility booking control loop
          </p>
          <h1 className="text-[38px] font-semibold leading-[1.1] tracking-[-0.03em]">
            Every instrument, slot and decision — accounted for.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-white/60">
            ResourceOS gives shared labs one auditable workflow: eligibility and training checks, conflict-free
            reservations, approvals, maintenance blackouts, incident evidence and utilization reporting.
          </p>

          <dl className="mt-9 grid grid-cols-3 gap-3">
            {[
              ["10", "Instruments"],
              ["90d", "Operating history"],
              ["0", "Double-bookings"],
            ].map(([value, label]) => (
              <div key={label} className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3">
                <dt className="text-2xl font-semibold tracking-tight">{value}</dt>
                <dd className="mt-0.5 text-[11px] text-white/45">{label}</dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="relative text-[11px] text-white/35">
          Rule-based by design · PostgreSQL range constraints · Tenant-isolated
        </p>
        <p className="relative mt-2 text-[11px] text-white/35">
          Demo workspace · every account uses the password demo1234
        </p>
      </section>

      <section className="flex items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-[400px]">
          <div className="mb-8 lg:hidden">
            <span className="inline-flex rounded-xl bg-night p-3 text-white">
              <Logo />
            </span>
          </div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-600">
            Meridian Institute of Technology
          </p>
          <h2 className="mt-1 text-[28px] font-semibold tracking-tight">Sign in</h2>
          <p className="mb-7 mt-1 text-sm text-muted">
            Use your institute account to book facilities or manage operations.
          </p>
          <LoginForm />
        </div>
      </section>
    </div>
  );
}
