/**
 * Set a user's role by email.
 *
 * Usage (from backend/):
 *   npm run prisma:set-user-role -- user@example.com admin
 *   npm run prisma:set-user-role -- user@example.com creator
 *   npm run prisma:set-user-role -- user@example.com reader
 *
 * Roles: reader | creator | admin | moderator (maps to UserRole enum)
 */
import { PrismaClient, UserRole } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

const directUrl = process.env.DIRECT_URL?.trim() || "";
const pooledUrl = process.env.DATABASE_URL?.trim() || "";
const databaseUrl = directUrl || pooledUrl;

if (!databaseUrl) {
  throw new Error("DATABASE_URL or DIRECT_URL must be set.");
}

const separator = databaseUrl.includes("?") ? "&" : "?";
const finalUrl = `${databaseUrl}${separator}connection_limit=1`;

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: finalUrl,
    },
  },
});

const ROLE_ALIASES: Record<string, UserRole> = {
  reader: UserRole.READER,
  r: UserRole.READER,
  creator: UserRole.CREATOR,
  c: UserRole.CREATOR,
  admin: UserRole.ADMIN,
  a: UserRole.ADMIN,
  moderator: UserRole.MODERATOR,
  mod: UserRole.MODERATOR,
  m: UserRole.MODERATOR,
};

function parseRole(arg: string): UserRole {
  const key = arg.trim().toLowerCase();
  const role = ROLE_ALIASES[key];
  if (!role) {
    throw new Error(
      `Invalid role "${arg}". Use: reader | creator | admin | moderator`,
    );
  }
  return role;
}

async function main() {
  const [, , emailArg, roleArg] = process.argv;
  if (!emailArg || !roleArg) {
    console.error(
      "Usage: npm run prisma:set-user-role -- <email> <reader|creator|admin|moderator>",
    );
    process.exit(1);
  }

  const email = emailArg.trim().toLowerCase();
  const role = parseRole(roleArg);

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, role: true },
  });

  if (!user) {
    console.error(`No user found with email: ${emailArg.trim()}`);
    process.exit(1);
  }

  if (user.role === role) {
    console.log(`User ${user.email} already has role ${role}.`);
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { role },
  });

  console.log(`Updated ${user.email}: ${user.role} → ${role}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
