import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { listConsumableMovements, listConsumables } from "@/lib/queries/readiness";
import { adjustStockAction, createConsumableAction } from "@/lib/actions/readiness";
import { Badge, EmptyState, Flash, PageHeader, SectionHeading, Stat } from "@/components/ui";
import { formatDateTime } from "@/lib/format";

export default async function ConsumablesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const user = await requireRole("admin", "manager", "technician");
  const query = await searchParams;
  const [items, movements] = await Promise.all([
    listConsumables(user.organizationId),
    listConsumableMovements(user.organizationId, 25),
  ]);

  const lowStock = items.filter((item) => item.low);
  const linked = items.filter((item) => item.requiredBy > 0);

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Consumables &amp; stock"
        description="Stock is checked before a session can start. A short mandatory item blocks the booking instead of failing in the lab."
        actions={
          <Link href="/readiness" className="btn-secondary">
            Operational readiness
          </Link>
        }
      />

      <Flash error={query.error} ok={query.ok} />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Stat label="Items tracked" value={items.length} hint="Across this workspace" />
        <Stat label="Below minimum" value={lowStock.length} hint="Reorder before the next busy week" tone={lowStock.length ? "amber" : "green"} />
        <Stat label="Required by assets" value={linked.length} hint="Linked to at least one resource" tone="brand" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <section className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
            <SectionHeading title="Catalogue" description="Quantity per session is configured on each asset." />
          </div>

          {items.length === 0 ? (
            <EmptyState
              title="No consumables yet"
              description="Add filament, reagents, gases or spare parts here, then attach them to the assets that need them."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="text-right">Stock</th>
                    <th>Status</th>
                    <th>Adjust</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <p className="font-medium text-ink">{item.name}</p>
                        <p className="font-mono text-[11px] text-muted">
                          {item.code} · {item.requiredBy} asset{item.requiredBy === 1 ? "" : "s"}
                          {item.supplier ? ` · ${item.supplier}` : ""}
                        </p>
                      </td>
                      <td className="text-right">
                        <p className="font-medium tabular-nums text-ink">
                          {item.stock} <span className="text-[11px] font-normal text-muted">{item.unit}</span>
                        </p>
                        <p className="text-[11px] text-muted">min {item.minStock}</p>
                      </td>
                      <td>
                        {item.low ? <Badge tone="amber">Below minimum</Badge> : <Badge tone="green">In stock</Badge>}
                      </td>
                      <td>
                        <form action={adjustStockAction} className="flex items-center gap-1.5">
                          <input type="hidden" name="consumable_id" value={item.id} />
                          <input
                            name="delta"
                            type="number"
                            step="0.01"
                            placeholder="+10"
                            aria-label={`Adjust stock for ${item.name}`}
                            className="input w-20 py-1.5"
                          />
                          <input
                            name="note"
                            placeholder="Note"
                            aria-label={`Reason for ${item.name}`}
                            className="input w-24 py-1.5"
                          />
                          <button type="submit" className="btn-secondary px-2.5 py-1.5 text-[12px]">
                            Apply
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="space-y-5">
          <section className="card-pad">
            <SectionHeading title="Add an item" description="Opening stock is recorded as a purchase movement." />
            <form action={createConsumableAction} className="mt-4 grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="code">
                    Code
                  </label>
                  <input id="code" name="code" className="input" placeholder="FIL-175" required />
                </div>
                <div>
                  <label className="label" htmlFor="unit">
                    Unit
                  </label>
                  <input id="unit" name="unit" className="input" placeholder="kg / L / roll" defaultValue="unit" />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="name">
                  Name
                </label>
                <input id="name" name="name" className="input" placeholder="PLA filament 1.75mm" required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="stock">
                    Opening stock
                  </label>
                  <input id="stock" name="stock" type="number" step="0.01" min="0" defaultValue="0" className="input" />
                </div>
                <div>
                  <label className="label" htmlFor="min_stock">
                    Minimum stock
                  </label>
                  <input id="min_stock" name="min_stock" type="number" step="0.01" min="0" defaultValue="0" className="input" />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="supplier">
                  Supplier
                </label>
                <input id="supplier" name="supplier" className="input" placeholder="Optional" />
              </div>
              <button type="submit" className="btn-primary">
                Add consumable
              </button>
            </form>
          </section>

          <section className="card-pad">
            <SectionHeading title="Recent movements" description="Every change is recorded with its actor and reason." />
            {movements.length === 0 ? (
              <p className="mt-3 text-sm text-muted">No stock movements yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {movements.map((movement) => (
                  <li key={movement.id} className="flex items-baseline justify-between gap-3 py-2">
                    <div>
                      <p className="text-[13px] font-medium text-ink">{movement.consumableName}</p>
                      <p className="text-[11px] text-muted">
                        {movement.reason} · {movement.actorName ?? "system"} · {formatDateTime(movement.createdAt)}
                      </p>
                    </div>
                    <span
                      className={`text-[13px] font-semibold tabular-nums ${
                        movement.delta > 0 ? "text-emerald-700" : "text-red-700"
                      }`}
                    >
                      {movement.delta > 0 ? "+" : ""}
                      {movement.delta} {movement.unit}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
