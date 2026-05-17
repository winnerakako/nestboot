import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Database seed script.
 * Populates the database with initial/demo data for development.
 *
 * Run with:
 *   npx prisma db seed
 *
 * Add your seed logic below. Each seeder function should be idempotent
 * (safe to run multiple times without creating duplicates).
 */
async function main() {
  console.log('Seeding database...');

  // Example: seed roles, default admin, lookup tables, etc.
  // await seedRoles(prisma);
  // await seedAdminUser(prisma);

  console.log('Seeding complete.');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
