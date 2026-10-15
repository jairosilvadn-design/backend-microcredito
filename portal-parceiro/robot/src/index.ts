import http from 'node:http';
import { iniciarWorker } from './fila.js';

iniciarWorker();
// Health-check para a plataforma de hospedagem (Render/Railway/Cloud Run exigem uma porta).
http.createServer((_, res) => { res.writeHead(200); res.end('ok'); }).listen(Number(process.env.PORT ?? 8080));
