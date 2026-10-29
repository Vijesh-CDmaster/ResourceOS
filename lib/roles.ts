export type Role = "admin" | "manager" | "technician" | "member";

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Administrator",
  manager: "Facility manager",
  technician: "Technician",
  member: "Member",
};

export const ROLE_RANK: Record<Role, number> = {
  admin: 40,
  manager: 30,
  technician: 20,
  member: 10,
};

export function hasRole(role: Role, ...allowed: Role[]): boolean {
  return allowed.includes(role);
}

export function isStaff(role: Role): boolean {
  return role === "admin" || role === "manager" || role === "technician";
}

export function canManage(role: Role): boolean {
  return role === "admin" || role === "manager";
}
