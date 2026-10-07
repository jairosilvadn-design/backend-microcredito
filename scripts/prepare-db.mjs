// Roda no build do Netlify: cria/atualiza as tabelas e garante o administrador inicial.
// `db push` SEM --accept-data-loss: se uma mudança apagar dados, o build falha e o site atual continua no ar.
import { execSync } from 'node:child_process';

const e = process.env;
const url = e.DATABASE_URL || e.NETLIFY_DB_URL || e.NETLIFY_DATABASE_URL;
const achou = ['DATABASE_URL', 'NETLIFY_DB_URL', 'NETLIFY_DATABASE_URL'].filter((k) => e[k]);
console.log(`prepare-db: variáveis de banco encontradas: ${achou.length ? achou.join(', ') : 'nenhuma'}`);
if (!url) { console.log('Sem banco configurado: pulando prepare-db (a API vai avisar no /health).'); process.exit(0); }
const direct = e.DIRECT_URL || e.NETLIFY_DATABASE_URL_UNPOOLED || url;
const env = { ...e, DATABASE_URL: direct, DIRECT_URL: direct };

execSync('npx prisma db push --skip-generate', { stdio: 'inherit', env });

const emails = (e.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
if (emails.length) {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: direct } } });
  for (const email of emails) {
    await prisma.operator.upsert({ where: { email }, create: { email, name: email.split('@')[0], role: 'admin' }, update: {} });
    console.log(`Operador admin garantido: ${email}`);
  }
  await prisma.$disconnect();
}
