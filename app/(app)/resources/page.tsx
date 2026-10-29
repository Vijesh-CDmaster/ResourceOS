import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listResources } from "@/lib/queries/resources";
import { formatHours } from "@/lib/format";
import { Icon } from "@/components/icons";
import { Badge, EmptyState, PageHeader, ResourceBadge } from "@/components/ui";

export default async function ResourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; category?: string; status?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const resources = await listResources(user.organizationId, {
    search: params.search,
    category: params.category,
    status: params.status,
  });

  const categories = ["Fabrication", "Characterisation", "Imaging", "Wet Lab", "Electronics", "Computing", "Testing"];
  const activeCategory = params.category ?? "";
  const qs = (next: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    const merged = { search: params.search, category: params.category, status: params.status, ...next };
    for (const [key, value] of Object.entries(merged)) if (value) search.set(key, value);
    const query = search.toString();
    return query ? `/resources?${query}` : "/resources";
  };

  return (
    <div>
      <PageHeader
        eyebrow="Facility catalogue"
        title="Resources"
        description="Search instruments and workspaces, check eligibility and reserve an available slot."
        actions={
          user.role === "admin" || user.role === "manager" ? (
            <Link href="/admin#resources" className="btn-secondary">
              <Icon name="plus" className="h-4 w-4" />
              Add resource
            </Link>
          ) : undefined
        }
      />

      <form action="/resources" method="get" className="card mb-5 flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Icon name="search" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            name="search"
            defaultValue={params.search}
            placeholder="Search by name, code, location or capability"
            className="input pl-9"
          />
        </div>
        {params.category ? <input type="hidden" name="category" value={params.category} /> : null}
        <select name="status" defaultValue={params.status ?? ""} className="input sm:w-44">
          <option value="">Any status</option>
          <option value="ready">Ready</option>
          <option value="maintenance">Maintenance</option>
          <option value="suspended">Suspended</option>
        </select>
        <button className="btn-primary" type="submit">
          Search
        </button>
      </form>

      <div className="mb-5 flex flex-wrap gap-1.5">
        <Link
          href={qs({ category: undefined })}
          className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
            !activeCategory ? "border-brand-700 bg-brand-700 text-white" : "border-line bg-white text-muted"
          }`}
        >
          All categories
        </Link>
        {categories.map((category) => (
          <Link
            key={category}
            href={qs({ category })}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
              activeCategory === category
                ? "border-brand-700 bg-brand-700 text-white"
                : "border-line bg-white text-muted hover:border-brand-200"
            }`}
          >
            {category}
          </Link>
        ))}
      </div>

      {resources.length === 0 ? (
        <EmptyState
          title="No resources match those filters"
          description="Try a broader search or clear the category filter."
          action={
            <Link href="/resources" className="btn-secondary">
              Reset filters
            </Link>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {resources.map((resource) => {
            const bookable = resource.status === "ready";
            return (
              <article key={resource.id} className="card group flex flex-col transition hover:border-brand-200">
                <div className="flex items-start justify-between gap-3 px-5 pt-5">
                  <div>
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-brand-600">
                      {resource.code}
                    </p>
                    <h2 className="mt-1 text-[15px] font-semibold leading-snug">
                      <Link href={`/resources/${resource.id}`} className="hover:text-brand-700">
                        {resource.name}
                      </Link>
                    </h2>
                  </div>
                  <ResourceBadge status={resource.status} />
                </div>

                <p className="mt-2 line-clamp-2 px-5 text-xs leading-relaxed text-muted">{resource.description}</p>

                <div className="mt-3 flex flex-wrap gap-1.5 px-5">
                  <Badge tone="slate">{resource.category}</Badge>
                  {resource.requiresApproval ? <Badge tone="amber">Approval</Badge> : <Badge tone="green">Instant</Badge>}
                  {resource.trainingName ? <Badge tone="violet">Training</Badge> : null}
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-line px-5 py-3.5 text-xs">
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-muted">Location</dt>
                    <dd className="mt-0.5 truncate font-medium text-ink/85">{resource.location || "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-muted">Max slot</dt>
                    <dd className="mt-0.5 font-medium text-ink/85">{formatHours(resource.maxHours)}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-muted">Capacity</dt>
                    <dd className="mt-0.5 font-medium text-ink/85">{resource.capacity} person(s)</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-wide text-muted">Upcoming</dt>
                    <dd className="mt-0.5 font-medium text-ink/85">{resource.upcomingCount} booking(s)</dd>
                  </div>
                </dl>

                <div className="mt-auto flex items-center justify-between border-t border-line px-5 py-3.5">
                  <span className="truncate text-[11px] text-muted">{resource.facilityName ?? "Unassigned"}</span>
                  <Link
                    href={`/resources/${resource.id}`}
                    className={`text-xs font-semibold ${bookable ? "text-brand-700" : "text-muted"}`}
                  >
                    {bookable ? "View & book →" : "View details →"}
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <p className="mt-6 text-xs text-muted">
        Availability, training and quota rules are evaluated again when you submit a request.
      </p>
    </div>
  );
}
