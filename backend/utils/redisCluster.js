// backend/utils/redisCluster.js
const IORedis = require('ioredis');
const { redisNodes, redisPassword } = require('../config/keys');
const { MockRedisClient } = require('./redisClient'); // MockRedisClient이 정의된 파일에서 불러옵니다

/**
 * Redis 클러스터 모드용 클라이언트
 * ioredis.Cluster을 사용하여 자동 파티셔닝 및 장애 복구를 지원합니다.
 */
class RedisClusterClient {
  constructor() {
    this.cluster = null;
    this.useMock = false;
  }

  async connect() {
    if (this.cluster) return this.cluster;

    // 클러스터 노드 설정이 없으면 인메모리 MockRedis 사용
    if (!Array.isArray(redisNodes) || redisNodes.length === 0) {
      console.log('Redis 클러스터 노드가 구성되지 않아 MockRedisClient 사용');
      this.useMock = true;
      this.cluster = new MockRedisClient();
      return this.cluster;
    }

    // ioredis 클러스터 생성
    this.cluster = new IORedis.Cluster(redisNodes, {
      redisOptions: { password: redisPassword },
      scaleReads: 'slave',              // 읽기를 슬레이브 노드로 분산
      clusterRetryStrategy: attempts => Math.min(100 + attempts * 50, 2000),
      retryDelayOnFailover: 1000,
      retryDelayOnClusterDown: 1000,
    });

    this.cluster.on('connect', () => console.log('ioredis cluster connected'));
    this.cluster.on('error', err => {
      console.error('ioredis cluster error:', err);
      if (!this.useMock) {
        console.log('클러스터 에러 발생, MockRedisClient로 전환');
        this.useMock = true;
        this.cluster = new MockRedisClient();
      }
    });

    return this.cluster;
  }

  async set(key, value, options = {}) {
    const client = await this.connect();
    const str = (typeof value === 'object' && value !== null) ? JSON.stringify(value) : String(value);
    if (options.ttl) {
      if (this.useMock) return client.set(key, value, { ttl: options.ttl });
      return client.set(key, str, 'EX', options.ttl);
    }
    return client.set(key, str);
  }

  async get(key) {
    const client = await this.connect();
    const val = await client.get(key);
    if (val == null) return null;
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }

  async del(key) {
    const client = await this.connect();
    return client.del(key);
  }

  async expire(key, seconds) {
    const client = await this.connect();
    return client.expire(key, seconds);
  }

  async keys(pattern) {
    const client = await this.connect();
    if (this.useMock) {
      return client.keys(pattern);
    }
    const masters = client.nodes('master');
    const results = await Promise.all(masters.map(node => node.keys(pattern)));
    return Array.from(new Set(results.flat()));
  }

  async quit() {
    if (this.cluster) {
      await this.cluster.quit();
      this.cluster = null;
      console.log('Redis 클러스터 연결 종료');
    }
  }

  // Redis Hash Commands
  async hset(key, field, value) {
    const client = await this.connect();
    return client.hset(key, field, value);
  }

  async hget(key, field) {
    const client = await this.connect();
    return client.hget(key, field);
  }

  async hdel(key, field) {
    const client = await this.connect();
    return client.hdel(key, field);
  }

  async hincrby(key, field, increment) {
    const client = await this.connect();
    return client.hincrby(key, field, increment);
  }

  async hvals(key) {
    const client = await this.connect();
    return client.hvals(key);
  }
}

module.exports = new RedisClusterClient();