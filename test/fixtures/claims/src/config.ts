export const config = {
  db: process.env.CLAIMS_DB_URL,
  ttl: Number(process.env['CLAIMS_CACHE_TTL'] ?? 60),
  region: process.env.CLAIMS_REGION,
  port: Number(process.env.PORT ?? 3000),
};
