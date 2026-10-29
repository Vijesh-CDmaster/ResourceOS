import { requireUser } from "@/lib/auth";
import { getShellCounts } from "@/lib/queries/dashboard";
import { AppShell } from "@/components/app-shell";
import { canManage } from "@/lib/roles";

export default async function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const counts = await getShellCounts(
    user.organizationId,
    user.userId,
    user.departmentId,
    canManage(user.role),
  );
  return (
    <AppShell
      user={user}
      departmentName={counts.departmentName}
      pendingCount={counts.pendingCount}
      unreadCount={counts.unreadCount}
    >
      {children}
    </AppShell>
  );
}
