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
try { const u = new URL(direct); console.log(`prepare-db: banco em uso: ${u.hostname}:${u.port || '5432'}${u.pathname} (usuário ${u.username})`); } catch { console.log('prepare-db: endereço do banco inválido (confira DIRECT_URL: senha com símbolos precisa ser codificada)'); }

try {
  execSync('npx prisma db push --skip-generate', { stdio: 'inherit', env });
} catch (err) {
  console.error('\nprepare-db: FALHOU ao atualizar o banco. Nada foi apagado. Se o erro for P1000, a senha do banco está errada ou tem símbolo sem codificar (@ vira %40, # vira %23, / vira %2F).');
  throw err;
}

// Confirma, só lendo, que este é o banco com os dados do cliente.
try {
  const { PrismaClient } = await import('@prisma/client');
  const p = new PrismaClient({ datasources: { db: { url: direct } } });
  const [clientes, contratos, parcelas, caixa] = await Promise.all([p.borrower.count(), p.creditContract.count(), p.creditInstallment.count(), p.cashEntry.count()]);
  console.log(`prepare-db: dados encontrados no banco -> clientes: ${clientes}, contratos: ${contratos}, parcelas: ${parcelas}, lançamentos de caixa: ${caixa}`);
  await p.$disconnect();
} catch (err) { console.log('prepare-db: não consegui contar os dados (isso não impede a publicação):', String(err.message || err).split('\n')[0]); }

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
