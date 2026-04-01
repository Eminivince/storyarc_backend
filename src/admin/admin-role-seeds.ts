/**
 * Default admin roles with permission mappings.
 * Used by seed script and admin management endpoints.
 */

export const ALL_PERMISSIONS = [
  // Content
  "content:books:read",
  "content:books:write",
  "content:books:visibility",
  "content:chapters:config",
  "content:featured:read",
  "content:featured:write",
  // Moderation
  "moderation:reports:read",
  "moderation:reports:resolve",
  "moderation:comments:read",
  "moderation:comments:moderate",
  "moderation:reviews:read",
  "moderation:reviews:moderate",
  // Users
  "users:read",
  "users:write",
  "users:status",
  "users:reset-password",
  // Finance
  "finance:dashboard",
  "finance:payouts",
  "finance:refunds",
  "finance:tax-forms",
  // Contracts
  "contracts:read",
  "contracts:write",
  "contracts:templates:read",
  "contracts:templates:write",
  // Settings
  "settings:read",
  "settings:write",
  "maintenance:execute",
  // Admin management
  "admin:manage",
  "admin:audit-log",
  // Help center
  "help-center:read",
  "help-center:write",
  // Support
  "support:tickets:read",
  "support:tickets:reply",
  // Creator applications
  "creator-apps:read",
  "creator-apps:decide",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

export type AdminRoleSeed = {
  name: string;
  label: string;
  permissions: Permission[];
  isSystem: boolean;
};

export const DEFAULT_ADMIN_ROLES: AdminRoleSeed[] = [
  {
    name: "SUPER_ADMIN",
    label: "Super Admin",
    isSystem: true,
    permissions: [...ALL_PERMISSIONS],
  },
  {
    name: "CONTENT_ADMIN",
    label: "Content Admin",
    isSystem: true,
    permissions: [
      "content:books:read",
      "content:books:write",
      "content:books:visibility",
      "content:chapters:config",
      "content:featured:read",
      "content:featured:write",
      "moderation:reports:read",
      "moderation:reports:resolve",
      "moderation:comments:read",
      "moderation:comments:moderate",
      "moderation:reviews:read",
      "moderation:reviews:moderate",
      "help-center:read",
      "help-center:write",
      "creator-apps:read",
      "creator-apps:decide",
      "admin:audit-log",
    ],
  },
  {
    name: "FINANCE_ADMIN",
    label: "Finance Admin",
    isSystem: true,
    permissions: [
      "finance:dashboard",
      "finance:payouts",
      "finance:refunds",
      "finance:tax-forms",
      "contracts:read",
      "contracts:write",
      "contracts:templates:read",
      "contracts:templates:write",
      "users:read",
      "admin:audit-log",
    ],
  },
  {
    name: "MODERATOR",
    label: "Moderator",
    isSystem: true,
    permissions: [
      "moderation:reports:read",
      "moderation:reports:resolve",
      "moderation:comments:read",
      "moderation:comments:moderate",
      "moderation:reviews:read",
      "moderation:reviews:moderate",
      "content:books:read",
      "users:read",
      "admin:audit-log",
    ],
  },
  {
    name: "SUPPORT_AGENT",
    label: "Support Agent",
    isSystem: true,
    permissions: [
      "support:tickets:read",
      "support:tickets:reply",
      "users:read",
      "help-center:read",
      "admin:audit-log",
    ],
  },
];
