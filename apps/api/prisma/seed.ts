import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const hyd = await prisma.district.upsert({ where: { name: 'Hyderabad' }, update: {}, create: { name: 'Hyderabad' } });
  await prisma.district.upsert({ where: { name: 'Warangal' }, update: {}, create: { name: 'Warangal' } });

  // Centre.name is not unique, so use a fixed id to keep the upsert idempotent.
  const centre = await prisma.centre.upsert({
    where: { id: 'centre-pragati-kukatpally' },
    update: {},
    create: { id: 'centre-pragati-kukatpally', name: 'Pragati Skill Centre, Kukatpally', districtId: hyd.id },
  });

  const users: { name: string; role: Role; districtId?: string; centreId?: string }[] = [
    { name: 'Anika', role: Role.CENTRE, districtId: hyd.id, centreId: centre.id },
    { name: 'Dev', role: Role.DISTRICT_OFFICER, districtId: hyd.id },
    { name: 'Meera', role: Role.DISTRICT_OFFICER, districtId: hyd.id },
    { name: 'Kabir', role: Role.DISTRICT_OFFICER, districtId: hyd.id },
    { name: 'Neha', role: Role.QUALITY },
    { name: 'Farah', role: Role.STATE },
  ];
  for (const u of users) {
    const email = `${u.name.toLowerCase()}@demo.certiflow`;
    await prisma.user.upsert({ where: { email }, update: { ...u }, create: { ...u, email } });
  }
  console.log(`seed ok: ${users.length} users`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
