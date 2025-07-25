// backend/config/keys.js
require('dotenv').config();

// 기본 키와 솔트 (개발 환경용)
const DEFAULT_ENCRYPTION_KEY = 'a'.repeat(64); // 32바이트를 hex로 표현
const DEFAULT_PASSWORD_SALT = 'b'.repeat(32); // 16바이트를 hex로 표현


const redisNodes = (() => {
  const raw = process.env.REDIS_CLUSTER_NODES;
  if (!raw) return [];
  try {
    // JSON 배열 형태
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr.map(item => {
        const [host, port] = item.split(':');
        return { host, port: Number(port) };
      });
    }
  } catch {}
  // 콤마 구분 문자열 형태
  return raw.split(',').map(pair => {
    const [host, port] = pair.split(':');
    return { host, port: Number(port) };
  });
})();


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
  // AWS S3 설정 추가
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  s3Region: process.env.S3_REGION,
  s3Bucket: process.env.S3_BUCKET,
  cloudfrontBaseUrl: process.env.CLOUDFRONT_BASE_URL,
  s3Folder: process.env.S3_FOLDER || 'uploads',
};