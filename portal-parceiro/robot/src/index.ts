import http from 'node:http';
import { iniciarWorker } from './fila.js';

import { log } from './logger.js';
process.on('unhandledRejection', (r) => log.error(`promessa rejeitada sem tratamento: ${r instanceof Error ? r.message : String(r)}`)); // não derruba o robô por causa de uma falha isolada
iniciarWorker();
// Health-check para a plataforma de hospedagem (Render/Railway/Cloud Run exigem uma porta).
http.createServer((_, res) => { res.writeHead(200); res.end('ok'); }).listen(Number(process.env.PORT ?? 8080));
