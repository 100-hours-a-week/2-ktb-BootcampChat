// backend/utils/redisClient.js
const Redis = require('ioredis');

class RedisClusterClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxRetries = 5;
  }

  async connect() {
    if (this.isConnected && this.client) {
      return this.client;
    }

    try {
      console.log('Connecting to Redis Cluster...');

      // Redis 클러스터 노드 설정
      const clusterNodes = process.env.REDIS_CLUSTER_NODES;
      
      if (!clusterNodes) {
        throw new Error('REDIS_CLUSTER_NODES environment variable is not set');
      }

      // 클러스터 노드 파싱
      const nodes = clusterNodes.split(',').map(node => {
        const [host, port] = node.trim().split(':');
        return { host, port: parseInt(port) };
      });

      console.log('Redis Cluster Nodes:', nodes);

      // IORedis 클러스터 클라이언트 생성
      this.client = new Redis.Cluster(nodes, {
        redisOptions: {
          password: process.env.REDIS_PASSWORD,
          connectTimeout: 10000,
          lazyConnect: true,
          maxRetriesPerRequest: 3,
          retryDelayOnFailover: 100,
          enableOfflineQueue: false,
        },
        clusterRetryDelayOnFailover: 100,
        clusterRetryDelayOnClusterDown: 300,
        clusterMaxRedirections: 16,
        scaleReads: 'slave',
        maxRedirections: 16,
        retryDelayOnFailover: 100,
        enableOfflineQueue: false,
      });

      // 이벤트 리스너 설정
      this.client.on('connect', () => {
        console.log('✅ Redis Cluster Connected');
        this.isConnected = true;
        this.connectionAttempts = 0;
      });

      this.client.on('ready', () => {
        console.log('✅ Redis Cluster Ready');
        this.isConnected = true;
      });

      this.client.on('error', (err) => {
        console.error('❌ Redis Cluster Error:', err.message);
        this.isConnected = false;
      });

      this.client.on('close', () => {
        console.log('🔌 Redis Cluster Connection Closed');
        this.isConnected = false;
      });

      this.client.on('reconnecting', () => {
        console.log('🔄 Redis Cluster Reconnecting...');
      });

      this.client.on('end', () => {
        console.log('🔚 Redis Cluster Connection Ended');
        this.isConnected = false;
      });

      // 연결 시도
      await this.client.connect();
      
      // 연결 테스트
      await this.client.ping();
      console.log('✅ Redis Cluster connection test successful');

      return this.client;

    } catch (error) {
      console.error('❌ Redis Cluster connection failed:', error.message);
      this.isConnected = false;
      throw error;
    }
  }

  async ensureConnection() {
    if (!this.isConnected || !this.client) {
      await this.connect();
    }
  }

  async set(key, value, options = {}) {
    try {
      await this.ensureConnection();

      let stringValue;
      if (typeof value === 'object') {
        stringValue = JSON.stringify(value);
      } else {
        stringValue = String(value);
      }

      if (options.ttl) {
        return await this.client.setex(key, options.ttl, stringValue);
      }
      return await this.client.set(key, stringValue);
    } catch (error) {
      console.error('Redis set error:', error);
      throw error;
    }
  }

  async get(key) {
    try {
      await this.ensureConnection();

      const value = await this.client.get(key);
      if (!value) return null;

      try {
        return JSON.parse(value);
      } catch (parseError) {
        return value;
      }
    } catch (error) {
      console.error('Redis get error:', error);
      throw error;
    }
  }

  async setEx(key, seconds, value) {
    try {
      await this.ensureConnection();

      let stringValue;
      if (typeof value === 'object') {
        stringValue = JSON.stringify(value);
      } else {
        stringValue = String(value);
      }

      return await this.client.setex(key, seconds, stringValue);
    } catch (error) {
      console.error('Redis setEx error:', error);
      throw error;
    }
  }

  async del(key) {
    try {
      await this.ensureConnection();
      return await this.client.del(key);
    } catch (error) {
      console.error('Redis del error:', error);
      throw error;
    }
  }

  async expire(key, seconds) {
    try {
      await this.ensureConnection();
      return await this.client.expire(key, seconds);
    } catch (error) {
      console.error('Redis expire error:', error);
      throw error;
    }
  }

  async hset(key, field, value) {
    try {
      await this.ensureConnection();
      
      let stringValue;
      if (typeof value === 'object') {
        stringValue = JSON.stringify(value);
      } else {
        stringValue = String(value);
      }
      
      return await this.client.hset(key, field, stringValue);
    } catch (error) {
      console.error('Redis hset error:', error);
      throw error;
    }
  }

  async hget(key, field) {
    try {
      await this.ensureConnection();
      
      const value = await this.client.hget(key, field);
      if (!value) return null;

      try {
        return JSON.parse(value);
      } catch (parseError) {
        return value;
      }
    } catch (error) {
      console.error('Redis hget error:', error);
      throw error;
    }
  }

  async hdel(key, field) {
    try {
      await this.ensureConnection();
      return await this.client.hdel(key, field);
    } catch (error) {
      console.error('Redis hdel error:', error);
      throw error;
    }
  }

  async hgetall(key) {
    try {
      await this.ensureConnection();
      
      const result = await this.client.hgetall(key);
      if (!result || Object.keys(result).length === 0) return {};

      const parsed = {};
      for (const [field, value] of Object.entries(result)) {
        try {
          parsed[field] = JSON.parse(value);
        } catch (parseError) {
          parsed[field] = value;
        }
      }
      
      return parsed;
    } catch (error) {
      console.error('Redis hgetall error:', error);
      throw error;
    }
  }

  async sadd(key, member) {
    try {
      await this.ensureConnection();
      return await this.client.sadd(key, member);
    } catch (error) {
      console.error('Redis sadd error:', error);
      throw error;
    }
  }

  async srem(key, member) {
    try {
      await this.ensureConnection();
      return await this.client.srem(key, member);
    } catch (error) {
      console.error('Redis srem error:', error);
      throw error;
    }
  }

  async smembers(key) {
    try {
      await this.ensureConnection();
      return await this.client.smembers(key);
    } catch (error) {
      console.error('Redis smembers error:', error);
      throw error;
    }
  }

  async sismember(key, member) {
    try {
      await this.ensureConnection();
      return await this.client.sismember(key, member);
    } catch (error) {
      console.error('Redis sismember error:', error);
      throw error;
    }
  }

  async keys(pattern) {
    try {
      await this.ensureConnection();
      return await this.client.keys(pattern);
    } catch (error) {
      console.error('Redis keys error:', error);
      throw error;
    }
  }

  async quit() {
    if (this.client) {
      try {
        await this.client.quit();
        this.isConnected = false;
        this.client = null;
        console.log('✅ Redis Cluster connection closed successfully');
      } catch (error) {
        console.error('Redis quit error:', error);
      }
    }
  }

  // 클러스터 상태 확인
  async getClusterInfo() {
    try {
      await this.ensureConnection();
      return await this.client.cluster('info');
    } catch (error) {
      console.error('Redis cluster info error:', error);
      throw error;
    }
  }

  // 클러스터 노드 정보
  async getClusterNodes() {
    try {
      await this.ensureConnection();
      return await this.client.cluster('nodes');
    } catch (error) {
      console.error('Redis cluster nodes error:', error);
      throw error;
    }
  }
}

const redisClient = new RedisClusterClient();
module.exports = redisClient;
