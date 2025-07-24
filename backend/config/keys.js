// backend/config/keys.js
require('dotenv').config();

// 기본 키와 솔트 (개발 환경용)
const DEFAULT_ENCRYPTION_KEY = 'a'.repeat(64); // 32바이트를 hex로 표현
const DEFAULT_PASSWORD_SALT = 'b'.repeat(32); // 16바이트를 hex로 표현


const redisNodes = (() => {
  const raw = process.env.REDIS_CLUSTER_NODES;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr.map(item => {
        try {
          const url = new URL(item);
          return { host: url.hostname, port: Number(url.port) };
        } catch {
          const [host, port] = item.replace('redis://', '').split(':');
          return { host, port: Number(port) };
        }
      });
    }
  } catch {}
  // 콤마 구분 문자열 형태 (host:port,host:port)
  return raw.split(',').map(pair => {
    const [host, port] = pair.replace('redis://', '').split(':');
    return { host, port: Number(port) };
  });
})();
console.log('🟢 [config/keys.js] redisNodes:', redisNodes);


module.exports = {
  mongoURI: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY || DEFAULT_ENCRYPTION_KEY,
  passwordSalt: process.env.PASSWORD_SALT || DEFAULT_PASSWORD_SALT,
  redisHost: process.env.REDIS_HOST,
  redisPassword: process.env.REDIS_PASSWORD,
  redisPort: process.env.REDIS_PORT,
  redisClusterNodes: process.env.REDIS_CLUSTER_NODES,
  redisNodes,
  openaiApiKey: process.env.OPENAI_API_KEY,
  vectorDbEndpoint: process.env.VECTOR_DB_ENDPOINT,
};