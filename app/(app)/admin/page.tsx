import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { getAdminLookups, listMembers, listTrainingRecords } from "@/lib/queries/admin";
import { listResources } from "@/lib/queries/resources";
import {
  createCourseAction,
  createDepartmentAction,
  createFacilityAction,
  grantTrainingAction,
  inviteMemberAction,
  updateOrgPolicyAction,
} from "@/lib/actions/admin";
import { createResourceAction, importResourcesAction } from "@/lib/actions/resources";
import { formatDate, formatHours } from "@/lib/format";
import { ROLE_LABEL, type Role } from "@/lib/roles";
import { Badge, Flash, PageHeader, ResourceBadge, SectionHeading } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const user = await requireRole("admin", "manager");
  const params = await searchParams;
  const [lookups, members, resources, training] = await Promise.all([
    getAdminLookups(user.organizationId),
    listMembers(user.organizationId),
    listResources(user.organizationId),
    listTrainingRecords(user.organizationId),
  ]);
  const isAdmin = user.role === "admin";
  const org = lookups.organization;

  return (
    <div>
      <PageHeader
        eyebrow="Workspace settings"
        title="Administration"
        description="Members, training records, facilities, resources and booking policy for this tenant."
        actions={
          <Link href="/audit" className="btn-secondary">
            Audit trail
          </Link>
        }
      />

      <Flash error={params.error} ok={params.ok} />

      <div className="grid gap-5 xl:grid-cols-[1.5fr_1fr]">
        <div className="space-y-5">
          <section id="members" className="card scroll-mt-24">
            <div className="border-b border-line px-5 py-4">
              <SectionHeading title="Members" description="Roles control approvals, maintenance and reporting." />
            </div>
            <div className="overflow-x-auto">
              <table className="table min-w-[640px]">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Role</th>
                    <th>Department</th>
                    <th className="text-right">Trainings</th>
                    <th className="text-right">Upcoming</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => (
                    <tr key={member.userId}>
                      <td>
                        <p className="text-sm font-medium">{member.name}</p>
                        <p className="text-[11px] text-muted">{member.email}</p>
                      </td>
                      <td>
                        <Badge tone={member.role === "admin" ? "brand" : member.role === "member" ? "slate" : "violet"}>
                          {ROLE_LABEL[member.role]}
                        </Badge>
                      </td>
                      <td className="text-xs">{member.departmentName ?? "—"}</td>
                      <td className="text-right text-xs">{member.validTrainings}</td>
                      <td className="text-right text-xs">{member.upcomingBookings}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section id="resources" className="card scroll-mt-24">
            <div className="border-b border-line px-5 py-4">
              <SectionHeading title="Resources" description="Bookable equipment, workspaces and services." />
            </div>
            <div className="overflow-x-auto">
              <table className="table min-w-[600px]">
                <thead>
                  <tr>
                    <th>Resource</th>
                    <th>Category</th>
                    <th>Status</th>
                    <th className="text-right">Max slot</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {resources.map((resource) => (
                    <tr key={resource.id}>
                      <td>
                        <p className="text-sm font-medium">{resource.name}</p>
                        <p className="font-mono text-[10px] uppercase tracking-wide text-muted">{resource.code}</p>
                      </td>
                      <td className="text-xs">{resource.category}</td>
                      <td>
                        <ResourceBadge status={resource.status} />
                      </td>
                      <td className="text-right text-xs">{formatHours(resource.maxHours)}</td>
                      <td className="text-right">
                        <Link href={`/resources/${resource.id}`} className="text-xs font-medium text-brand-700 hover:underline">
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card-pad">
            <SectionHeading
              title="Training register"
              description="Certifications gate access to restricted equipment."
            />
            <div className="overflow-x-auto">
              <table className="table min-w-[520px]">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Course</th>
                    <th>Granted</th>
                    <th>Expires</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {training.slice(0, 12).map((record) => (
                    <tr key={record.id}>
                      <td className="text-xs font-medium">{record.userName}</td>
                      <td className="text-xs">{record.courseName}</td>
                      <td className="text-xs text-muted">{formatDate(record.grantedAt)}</td>
                      <td className="text-xs text-muted">{formatDate(record.expiresAt)}</td>
                      <td>
                        <Badge tone={record.expired ? "red" : "green"}>{record.expired ? "expired" : "valid"}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div className="space-y-5">
          {isAdmin ? (
            <section className="card-pad">
              <SectionHeading title="Booking policy" description="Applies to every member in this tenant." />
              {org ? (
                <form action={updateOrgPolicyAction} className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="max_active_bookings" className="label">
                        Active bookings / user
                      </label>
                      <input
                        id="max_active_bookings"
                        name="max_active_bookings"
                        type="number"
                        min={1}
                        max={20}
                        defaultValue={org.max_active_bookings}
                        className="input"
                      />
                    </div>
                    <div>
                      <label htmlFor="max_horizon_days" className="label">
                        Booking horizon (days)
                      </label>
                      <input
                        id="max_horizon_days"
                        name="max_horizon_days"
                        type="number"
                        min={1}
                        max={365}
                        defaultValue={org.max_horizon_days}
                        className="input"
                      />
                    </div>
                    <div>
                      <label htmlFor="open_hour" className="label">
                        Opens (hour)
                      </label>
                      <input id="open_hour" name="open_hour" type="number" min={0} max={23} defaultValue={org.open_hour} className="input" />
                    </div>
                    <div>
                      <label htmlFor="close_hour" className="label">
                        Closes (hour)
                      </label>
                      <input id="close_hour" name="close_hour" type="number" min={1} max={24} defaultValue={org.close_hour} className="input" />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="no_show_grace_minutes" className="label">
                      No-show grace (minutes)
                    </label>
                    <input
                      id="no_show_grace_minutes"
                      name="no_show_grace_minutes"
                      type="number"
                      min={0}
                      max={180}
                      defaultValue={org.no_show_grace_minutes}
                      className="input"
                    />
                  </div>
                  <SubmitButton className="btn-primary w-full" pendingLabel="Saving…">
                    Save policy
                  </SubmitButton>
                </form>
              ) : null}
            </section>
          ) : null}

          <section id="training" className="card-pad scroll-mt-24">
            <SectionHeading title="Record a certification" description="Grants access immediately." />
            <form action={grantTrainingAction} className="space-y-3">
              <div>
                <label htmlFor="user_id" className="label">
                  Member
                </label>
                <select id="user_id" name="user_id" required className="input">
                  <option value="" disabled>
                    Choose a member
                  </option>
                  {lookups.members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name} — {member.email}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-[1fr_90px] gap-2">
                <div>
                  <label htmlFor="course_id" className="label">
                    Course
                  </label>
                  <select id="course_id" name="course_id" required className="input">
                    <option value="" disabled>
                      Choose a course
                    </option>
                    {lookups.courses.map((course) => (
                      <option key={course.id} value={course.id}>
                        {course.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="months" className="label">
                    Months
                  </label>
                  <input id="months" name="months" type="number" min={1} max={60} defaultValue={12} className="input" />
                </div>
              </div>
              <SubmitButton className="btn-primary w-full" pendingLabel="Recording…">
                Record training
              </SubmitButton>
            </form>

            <div className="mt-5 border-t border-line pt-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">New training course</p>
              <form action={createCourseAction} className="flex flex-col gap-2 sm:flex-row">
                <input name="name" required placeholder="Course name" className="input flex-1" />
                <input name="validity_months" type="number" min={1} max={60} defaultValue={12} className="input sm:w-24" />
                <SubmitButton className="btn-secondary" pendingLabel="Adding…">
                  Add
                </SubmitButton>
              </form>
            </div>
          </section>

          {isAdmin ? (
            <section className="card-pad">
              <SectionHeading title="Invite a member" description="Share the temporary password out of band." />
              <form action={inviteMemberAction} className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="invite_name" className="label">
                      Name
                    </label>
                    <input id="invite_name" name="name" required className="input" />
                  </div>
                  <div>
                    <label htmlFor="invite_email" className="label">
                      Email
                    </label>
                    <input id="invite_email" name="email" type="email" required className="input" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="invite_role" className="label">
                      Role
                    </label>
                    <select id="invite_role" name="role" defaultValue="member" className="input">
                      {(Object.keys(ROLE_LABEL) as Role[]).map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABEL[role]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="invite_department" className="label">
                      Department
                    </label>
                    <select id="invite_department" name="department_id" defaultValue="" className="input">
                      <option value="">None</option>
                      {lookups.departments.map((department) => (
                        <option key={department.id} value={department.id}>
                          {department.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label htmlFor="temp_password" className="label">
                    Temporary password
                  </label>
                  <input id="temp_password" name="temp_password" type="text" minLength={8} required className="input font-mono" />
                </div>
                <SubmitButton className="btn-primary w-full" pendingLabel="Inviting…">
                  Add member
                </SubmitButton>
              </form>
            </section>
          ) : null}

          <section className="card-pad">
            <SectionHeading title="Add resource" description="Comes with Mon–Sat opening hours from the workspace policy." />
            <form action={createResourceAction} className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="code" className="label">
                    Code
                  </label>
                  <input id="code" name="code" required placeholder="SEM-01" className="input uppercase" />
                </div>
                <div>
                  <label htmlFor="name" className="label">
                    Name
                  </label>
                  <input id="name" name="name" required placeholder="Scanning Electron Microscope" className="input" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="category" className="label">
                    Category
                  </label>
                  <input id="category" name="category" defaultValue="General" className="input" />
                </div>
                <div>
                  <label htmlFor="max_hours" className="label">
                    Max hours / slot
                  </label>
                  <input id="max_hours" name="max_hours" type="number" step="0.5" min="0.5" defaultValue="4" className="input" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="facility_id" className="label">
                    Facility
                  </label>
                  <select id="facility_id" name="facility_id" defaultValue="" className="input">
                    <option value="">Unassigned</option>
                    {lookups.facilities.map((facility) => (
                      <option key={facility.id} value={facility.id}>
                        {facility.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="department_id" className="label">
                    Department
                  </label>
                  <select id="department_id" name="department_id" defaultValue="" className="input">
                    <option value="">All departments</option>
                    {lookups.departments.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label htmlFor="location" className="label">
                  Location
                </label>
                <input id="location" name="location" className="input" placeholder="Block D, Room 212" />
              </div>
              <div>
                <label htmlFor="description" className="label">
                  Description
                </label>
                <textarea id="description" name="description" rows={2} className="input" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="training_course_id" className="label">
                    Required training
                  </label>
                  <select id="training_course_id" name="training_course_id" defaultValue="" className="input">
                    <option value="">None</option>
                    {lookups.courses.map((course) => (
                      <option key={course.id} value={course.id}>
                        {course.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="capacity" className="label">
                    Capacity
                  </label>
                  <input id="capacity" name="capacity" type="number" min={1} defaultValue={1} className="input" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" name="requires_approval" value="yes" className="h-3.5 w-3.5" />
                Require manager approval
              </label>
              <SubmitButton className="btn-primary w-full" pendingLabel="Creating…">
                Create resource
              </SubmitButton>
            </form>
          </section>

          <section className="card-pad">
            <SectionHeading title="Departments & facilities" />
            <div className="grid gap-3">
              <form action={createDepartmentAction} className="flex gap-2">
                <input name="name" required placeholder="New department" className="input" />
                <SubmitButton className="btn-secondary" pendingLabel="…">
                  Add
                </SubmitButton>
              </form>
              <form action={createFacilityAction} className="flex flex-wrap gap-2">
                <input name="name" required placeholder="New facility" className="input flex-1" />
                <input name="location" placeholder="Location" className="input flex-1" />
                <SubmitButton className="btn-secondary" pendingLabel="…">
                  Add
                </SubmitButton>
              </form>
            </div>
          </section>

          <section className="card-pad">
            <SectionHeading title="Import resources (CSV)" description="One resource per line. Unknown facilities or courses are skipped with a report." />
            <form action={importResourcesAction} className="space-y-2">
              <textarea
                name="csv"
                rows={5}
                required
                className="input font-mono text-[11px]"
                placeholder={"code,name,category,facility,department,description,capacity,requires_approval,training,max_hours,location\nSEM-01,Scanning Electron Microscope,Imaging,Materials Characterisation Lab,Chemistry,Field-emission SEM,2,yes,,3,Block D Room 210"}
              />
              <SubmitButton className="btn-secondary w-full" pendingLabel="Importing…">
                Import CSV
              </SubmitButton>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
