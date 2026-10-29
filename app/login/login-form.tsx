"use client";

import { useActionState, useState } from "react";
import { loginAction, type LoginState } from "./actions";
import { SubmitButton } from "@/components/submit-button";

const DEMO_ACCOUNTS = [
  { email: "priya@meridian.edu", name: "Priya Raghavan", role: "Administrator" },
  { email: "arun@meridian.edu", name: "Arun Menon", role: "Facility manager" },
  { email: "kavya@meridian.edu", name: "Kavya Iyer", role: "Technician" },
  { email: "rohan@meridian.edu", name: "Rohan Sharma", role: "Member" },
];

export function LoginForm() {
  const [state, action] = useActionState<LoginState, FormData>(loginAction, null);
  const [email, setEmail] = useState("arun@meridian.edu");
  const [password, setPassword] = useState("demo1234");

  return (
    <div>
      <form action={action} className="space-y-4">
        <div>
          <label htmlFor="email" className="label">
            Institute email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="input"
            placeholder="you@meridian.edu"
          />
        </div>
        <div>
          <label htmlFor="password" className="label">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="input"
            placeholder="••••••••"
          />
        </div>

        {state?.error ? (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.error}
          </p>
        ) : null}

        <SubmitButton className="btn-primary w-full py-2.5" pendingLabel="Signing in…">
          Sign in to ResourceOS
        </SubmitButton>
      </form>

      <div className="mt-7">
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Demo accounts</p>
        <div className="mt-2 grid gap-1.5">
          {DEMO_ACCOUNTS.map((account) => (
            <button
              key={account.email}
              type="button"
              onClick={() => {
                setEmail(account.email);
                setPassword("demo1234");
              }}
              className="flex items-center justify-between rounded-lg border border-line bg-white px-3 py-2 text-left transition hover:border-brand-200 hover:bg-brand-50"
            >
              <span>
                <span className="block text-xs font-semibold text-ink">{account.name}</span>
                <span className="block text-[11px] text-muted">{account.email}</span>
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-brand-700">
                {account.role}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-muted">
          Every demo account uses the password <span className="font-mono text-ink">demo1234</span>.
        </p>
      </div>
    </div>
  );
}
