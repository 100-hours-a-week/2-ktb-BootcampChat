// backend/utils/socketRedisAdapter.js
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
const { redisPassword, redisClusterNodes, redisHost, redisPort } = require('../config/keys');

class SocketRedisAdapter {
  constructor() {
    this.pubClient = null;
    this.subClient = null;
    this.adapter = null;
  }

  createClusterClient() {
    // 클러스터 설정이 있으면 클러스터 모드, 없으면 단일 인스턴스
    if (redisClusterNodes) {
      const clusterNodes = redisClusterNodes.split(',').map(node => node.trim());
      
      return new Redis.Cluster(clusterNodes, {
        redisOptions: {
          password: redisPassword || 'yourPassword',
          connectTimeout: 10000,
          lazyConnect: true,
          maxRetriesPerRequest: 3,
          retryDelayOnFailover: 100,
          enableOfflineQueue: false,
          family: 4,
        },
        scaleReads: 'slave',
        enableReadyCheck: true,
        maxRedirections: 16,
        retryDelayOnClusterDown: 300,
        retryDelayOnFailover: 100,
        slotsRefreshTimeout: 10000,
        slotsRefreshInterval: 5000,
      });
    } else {
      // 단일 Redis 인스턴스
      return new Redis({
        host: redisHost || 'localhost',
        port: redisPort || 6379,
        password: redisPassword,
        connectTimeout: 5000,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100,
        enableOfflineQueue: false,
        family: 4,
      });
    }
  }

  async initialize(io) {
    try {
      console.log('Initializing Socket.IO Redis Adapter...');

      // Pub/Sub용 클라이언트 생성
      this.pubClient = this.createClusterClient();
      this.subClient = this.createClusterClient();

      // 에러 핸들링
      this.pubClient.on('error', (err) => {
        console.error('Socket.IO Redis Pub Client Error:', err);
      });

      this.subClient.on('error', (err) => {
        console.error('Socket.IO Redis Sub Client Error:', err);
      });

      // Redis Adapter 생성
      this.adapter = createAdapter(this.pubClient, this.subClient, {
        key: 'socket.io',
        requestsTimeout: 5000,
      });

      // Socket.IO에 어댑터 설정
      io.adapter(this.adapter);

      // 연결 상태 모니터링
      this.adapter.on('error', (err) => {
        console.error('Socket.IO Redis Adapter Error:', err);
      });

      console.log('Socket.IO Redis Adapter initialized successfully');
      return this.adapter;

    } catch (error) {
      console.error('Failed to initialize Socket.IO Redis Adapter:', error);
      console.log('Socket.IO will use in-memory adapter');
      throw error;
    }
  }

  async close() {
    try {
      if (this.pubClient) {
        await this.pubClient.quit();
      }
      if (this.subClient) {
        await this.subClient.quit();
      }
      console.log('Socket.IO Redis Adapter closed successfully');
    } catch (error) {
      console.error('Error closing Socket.IO Redis Adapter:', error);
    }
  }

  // 어댑터 상태 확인
  getStatus() {
    return {
      pubClientStatus: this.pubClient ? this.pubClient.status : 'disconnected',
      subClientStatus: this.subClient ? this.subClient.status : 'disconnected',
      adapterInitialized: !!this.adapter
    };
  }
}

module.exports = SocketRedisAdapter;