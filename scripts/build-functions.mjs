// Gera as Netlify Functions já empacotadas (ESM com "require" disponível), em netlify/functions/*.mjs.
// Sem isso o empacotador padrão do Netlify gera ESM puro e as bibliotecas CommonJS do servidor quebram.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('netlify/functions', { recursive: true });
for (const nome of ['api', 'credit-daily']) {
  await build({
    entryPoints: [`functions-src/${nome}.mts`],
    outfile: `netlify/functions/${nome}.mjs`,
    bundle: true, platform: 'node', target: 'node22', format: 'esm', minify: false, legalComments: 'none',
    external: ['@prisma/client', '.prisma/client'],
    banner: {
      // Globais (e não "const"): o Netlify reprocessa o arquivo e acrescenta as próprias declarações; "const" colidiria.
      js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; globalThis.require ??= __cr(import.meta.url); globalThis.__filename ??= __fu(import.meta.url); globalThis.__dirname ??= __dn(globalThis.__filename);",
    },
  });
  console.log(`função gerada: netlify/functions/${nome}.mjs`);
}
