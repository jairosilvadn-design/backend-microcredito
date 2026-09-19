// Variáveis fictícias só para os testes unitários (nenhuma chamada real é feita).
import { randomBytes } from 'node:crypto';
Object.assign(process.env, {
  DATABASE_URL: 'postgresql://test@localhost/test', FIREBASE_PROJECT_ID: 'test', CORS_ORIGINS: 'https://test.local',
  MP_CLIENT_ID: '1', MP_CLIENT_SECRET: 's', MP_REDIRECT_URI: 'https://test.local/cb', MP_WEBHOOK_SECRET: 'w',
  MP_PLATFORM_ACCESS_TOKEN: 't', MP_PLATFORM_USER_ID: '1', TOKEN_ENC_KEYS: `v1:${randomBytes(32).toString('base64')}`,
  TOKEN_ENC_ACTIVE_KID: 'v1', APP_PUBLIC_URL: 'https://test.local', PIX_DEFAULT_PAYER_EMAIL: 'p@test.local',
});
