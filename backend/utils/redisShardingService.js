// utils/redisShardingService.js
const Redis = require('ioredis');

class RedisShardingService {
  constructor() {
    // Redis 클러스터 설정 (샤딩을 위한 여러 노드)
    this.clusters = {
      read: new Redis.Cluster([
        { host: 'redis-read-1', port: 6379 },
        { host: 'redis-read-2', port: 6379 },
        { host: 'redis-read-3', port: 6379 }
      ], {
        enableReadyCheck: false,
        redisOptions: {
          password: process.env.REDIS_PASSWORD
        }
      }),
      
      write: new Redis.Cluster([
        { host: 'redis-write-1', port: 6379 },
        { host: 'redis-write-2', port: 6379 },
        { host: 'redis-write-3', port: 6379 }
      ], {
        enableReadyCheck: false,
        redisOptions: {
          password: process.env.REDIS_PASSWORD
        }
      })
    };

    // 읽기 전용 슬레이브 노드들
    this.readReplicas = [
      new Redis({ host: 'redis-slave-1', port: 6379, password: process.env.REDIS_PASSWORD }),
      new Redis({ host: 'redis-slave-2', port: 6379, password: process.env.REDIS_PASSWORD }),
      new Redis({ host: 'redis-slave-3', port: 6379, password: process.env.REDIS_PASSWORD })
    ];

    this.currentReadIndex = 0;
  }

  // 샤딩 키 생성 (방 ID 기반)
  getShardKey(roomId) {
    // CRC32 해시를 사용하여 샤드 결정
    const hash = this.crc32(roomId) >>> 0; // unsigned 32-bit
    return hash % 3; // 3개 샤드로 분산
  }

  // CRC32 해시 함수
  crc32(str) {
    let crc = 0 ^ (-1);
    for (let i = 0; i < str.length; i++) {
      crc = (crc >>> 8) ^ this.crc32Table[(crc ^ str.charCodeAt(i)) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
  }

  // CRC32 테이블 초기화
  get crc32Table() {
    if (!this._crc32Table) {
      this._crc32Table = [];
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
          c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
        }
        this._crc32Table[n] = c;
      }
    }
    return this._crc32Table;
  }

  // 읽기용 클라이언트 선택 (라운드 로빈)
  getReadClient() {
    const client = this.readReplicas[this.currentReadIndex];
    this.currentReadIndex = (this.currentReadIndex + 1) % this.readReplicas.length;
    return client;
  }

  // Write-Through 패턴으로 데이터 저장
  async writeThrough(key, data, ttl = 3600) {
    try {
      // 1. Redis에 먼저 저장 (Write-Through)
      await this.clusters.write.setEx(key, ttl, JSON.stringify(data));
      
      // 2. 모든 읽기 노드에도 복제
      const replicationPromises = this.readReplicas.map(client => 
        client.setEx(key, ttl, JSON.stringify(data)).catch(err => {
          console.error(`Read replica sync error for key ${key}:`, err);
        })
      );
      
      // 복제는 비동기로 처리 (성능 향상)
      Promise.all(replicationPromises);
      
      console.log(`[WriteThrough] Data written to cache: ${key}`);
      return true;
    } catch (error) {
      console.error(`[WriteThrough] Error writing key ${key}:`, error);
      throw error;
    }
  }

  // 샤드별 읽기
  async readFromShard(key) {
    try {
      // 라운드 로빈으로 읽기 노드 선택
      const client = this.getReadClient();
      const data = await client.get(key);
      
      if (data) {
        console.log(`[ReadShard] Cache hit for key: ${key}`);
        return JSON.parse(data);
      }
      
      console.log(`[ReadShard] Cache miss for key: ${key}`);
      return null;
    } catch (error) {
      console.error(`[ReadShard] Error reading key ${key}:`, error);
      
      // Fallback: 다른 읽기 노드 시도
      try {
        const fallbackClient = this.readReplicas[(this.currentReadIndex + 1) % this.readReplicas.length];
        const data = await fallbackClient.get(key);
        return data ? JSON.parse(data) : null;
      } catch (fallbackError) {
        console.error(`[ReadShard] Fallback read failed for key ${key}:`, fallbackError);
        return null;
      }
    }
  }

  // 배치 읽기 (여러 키를 한번에)
  async mget(keys) {
    try {
      const client = this.getReadClient();
      const values = await client.mget(...keys);
      
      return values.map((value, index) => ({
        key: keys[index],
        value: value ? JSON.parse(value) : null
      }));
    } catch (error) {
      console.error('[ReadShard] Batch read error:', error);
      return keys.map(key => ({ key, value: null }));
    }
  }

  // 배치 쓰기
  async mset(keyValuePairs, ttl = 3600) {
    try {
      const pipeline = this.clusters.write.pipeline();
      
      for (const { key, value } of keyValuePairs) {
        pipeline.setEx(key, ttl, JSON.stringify(value));
      }
      
      await pipeline.exec();
      
      // 읽기 노드들에도 복제
      const replicationPromises = this.readReplicas.map(client => {
        const replicaPipeline = client.pipeline();
        for (const { key, value } of keyValuePairs) {
          replicaPipeline.setEx(key, ttl, JSON.stringify(value));
        }
        return replicaPipeline.exec().catch(err => {
          console.error('Batch replication error:', err);
        });
      });
      
      Promise.all(replicationPromises);
      
      console.log(`[BatchWrite] Wrote ${keyValuePairs.length} keys to cache`);
      return true;
    } catch (error) {
      console.error('[BatchWrite] Error:', error);
      throw error;
    }
  }

  // 키 삭제 (모든 노드에서)
  async delete(keys) {
    try {
      const keysArray = Array.isArray(keys) ? keys : [keys];
      
      // 쓰기 클러스터에서 삭제
      await this.clusters.write.del(...keysArray);
      
      // 읽기 노드들에서도 삭제
      const deletionPromises = this.readReplicas.map(client => 
        client.del(...keysArray).catch(err => {
          console.error('Read replica deletion error:', err);
        })
      );
      
      await Promise.all(deletionPromises);
      
      console.log(`[Delete] Deleted keys: ${keysArray.join(', ')}`);
      return true;
    } catch (error) {
      console.error('[Delete] Error:', error);
      throw error;
    }
  }

  // 패턴 기반 키 삭제
  async deletePattern(pattern) {
    try {
      // 모든 노드에서 패턴 매칭 키 찾기
      const allKeys = new Set();
      
      // 쓰기 클러스터에서 키 찾기
      const writeKeys = await this.clusters.write.keys(pattern);
      writeKeys.forEach(key => allKeys.add(key));
      
      // 읽기 노드들에서도 키 찾기
      for (const client of this.readReplicas) {
        try {
          const readKeys = await client.keys(pattern);
          readKeys.forEach(key => allKeys.add(key));
        } catch (err) {
          console.error('Pattern search error on read replica:', err);
        }
      }
      
      if (allKeys.size > 0) {
        await this.delete(Array.from(allKeys));
      }
      
      console.log(`[DeletePattern] Deleted ${allKeys.size} keys matching pattern: ${pattern}`);
      return Array.from(allKeys);
    } catch (error) {
      console.error('[DeletePattern] Error:', error);
      throw error;
    }
  }

  // 연결 상태 확인
  async healthCheck() {
    const results = {
      writeCluster: false,
      readCluster: false,
      readReplicas: []
    };

    try {
      // 쓰기 클러스터 상태 확인
      await this.clusters.write.ping();
      results.writeCluster = true;
    } catch (error) {
      console.error('Write cluster health check failed:', error);
    }

    try {
      // 읽기 클러스터 상태 확인
      await this.clusters.read.ping();
      results.readCluster = true;
    } catch (error) {
      console.error('Read cluster health check failed:', error);
    }

    // 읽기 복제본들 상태 확인
    for (let i = 0; i < this.readReplicas.length; i++) {
      try {
        await this.readReplicas[i].ping();
        results.readReplicas[i] = true;
      } catch (error) {
        console.error(`Read replica ${i} health check failed:`, error);
        results.readReplicas[i] = false;
      }
    }

    return results;
  }

  // 통계 정보 조회
  async getStats() {
    try {
      const writeInfo = await this.clusters.write.info('memory');
      const readInfo = await this.clusters.read.info('memory');
      
      // 클러스터 노드 정보 조회
      const writeNodes = await this.clusters.write.cluster('nodes').catch(() => 'Cluster info unavailable');
      const readNodes = await this.clusters.read.cluster('nodes').catch(() => 'Cluster info unavailable');
      
      return {
        write: {
          memory: this.parseMemoryInfo(writeInfo),
          nodes: writeNodes,
          status: 'connected'
        },
        read: {
          memory: this.parseMemoryInfo(readInfo),
          nodes: readNodes,
          status: 'connected'
        },
        replicas: await Promise.all(
          this.readReplicas.map(async (client, index) => {
            try {
              const info = await client.info('memory');
              const ping = await client.ping();
              return { 
                index, 
                status: ping === 'PONG' ? 'healthy' : 'unhealthy', 
                memory: this.parseMemoryInfo(info),
                lastPing: Date.now()
              };
            } catch (error) {
              return { 
                index, 
                status: 'error', 
                error: error.message,
                lastError: Date.now()
              };
            }
          })
        ),
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('[Stats] Error getting Redis stats:', error);
      return { 
        error: error.message,
        timestamp: Date.now(),
        status: 'error'
      };
    }
  }

  // 메모리 정보 파싱
  parseMemoryInfo(info) {
    try {
      const lines = info.split('\r\n');
      const memoryInfo = {};
      
      lines.forEach(line => {
        if (line.includes(':')) {
          const [key, value] = line.split(':');
          if (key.includes('memory') || key.includes('used') || key.includes('max')) {
            memoryInfo[key] = value;
          }
        }
      });
      
      return memoryInfo;
    } catch (error) {
      return { error: 'Failed to parse memory info' };
    }
  }

  // 클러스터 정보 조회
  async getClusterInfo() {
    try {
      const writeClusterInfo = {
        info: await this.clusters.write.cluster('info').catch(e => ({ error: e.message })),
        nodes: await this.clusters.write.cluster('nodes').catch(e => ({ error: e.message })),
        slots: await this.clusters.write.cluster('slots').catch(e => ({ error: e.message }))
      };

      const readClusterInfo = {
        info: await this.clusters.read.cluster('info').catch(e => ({ error: e.message })),
        nodes: await this.clusters.read.cluster('nodes').catch(e => ({ error: e.message })),
        slots: await this.clusters.read.cluster('slots').catch(e => ({ error: e.message }))
      };

      return {
        write: writeClusterInfo,
        read: readClusterInfo,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('[ClusterInfo] Error:', error);
      return { error: error.message };
    }
  }

  // 샤드별 키 분포 확인
  async getKeyDistribution() {
    try {
      const distribution = {
        total: 0,
        shards: {},
        patterns: {}
      };

      // 각 읽기 노드에서 키 개수 확인
      for (let i = 0; i < this.readReplicas.length; i++) {
        try {
          const client = this.readReplicas[i];
          
          // 전체 키 개수
          const totalKeys = await client.dbsize();
          distribution.shards[i] = totalKeys;
          distribution.total += totalKeys;

          // 패턴별 키 개수
          const patterns = ['messages:*', 'room:*', 'user:*', 'recent:*'];
          for (const pattern of patterns) {
            const keys = await client.keys(pattern);
            if (!distribution.patterns[pattern]) {
              distribution.patterns[pattern] = 0;
            }
            distribution.patterns[pattern] += keys.length;
          }

        } catch (error) {
          console.error(`Error getting distribution from replica ${i}:`, error);
          distribution.shards[i] = { error: error.message };
        }
      }

      return {
        ...distribution,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('[KeyDistribution] Error:', error);
      return { error: error.message };
    }
  }

  // 캐시 적중률 통계 (Redis INFO 기반)
  async getCacheHitRatio() {
    try {
      const stats = {};

      // 각 읽기 노드의 적중률 계산
      for (let i = 0; i < this.readReplicas.length; i++) {
        try {
          const client = this.readReplicas[i];
          const info = await client.info('stats');
          
          const hits = this.extractStatValue(info, 'keyspace_hits');
          const misses = this.extractStatValue(info, 'keyspace_misses');
          const total = hits + misses;
          
          stats[`replica_${i}`] = {
            hits,
            misses,
            total,
            hitRatio: total > 0 ? (hits / total * 100).toFixed(2) + '%' : '0%'
          };
        } catch (error) {
          stats[`replica_${i}`] = { error: error.message };
        }
      }

      return {
        replicas: stats,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('[CacheHitRatio] Error:', error);
      return { error: error.message };
    }
  }

  // INFO 문자열에서 특정 값 추출
  extractStatValue(info, key) {
    try {
      const lines = info.split('\r\n');
      for (const line of lines) {
        if (line.startsWith(key + ':')) {
          return parseInt(line.split(':')[1]) || 0;
        }
      }
      return 0;
    } catch (error) {
      return 0;
    }
  }

  // 메모리 사용량 모니터링
  async getMemoryUsage() {
    try {
      const usage = {
        write: {},
        read: {},
        replicas: []
      };

      // 쓰기 클러스터 메모리 사용량
      try {
        const writeInfo = await this.clusters.write.info('memory');
        usage.write = this.parseDetailedMemoryInfo(writeInfo);
      } catch (error) {
        usage.write = { error: error.message };
      }

      // 읽기 클러스터 메모리 사용량
      try {
        const readInfo = await this.clusters.read.info('memory');
        usage.read = this.parseDetailedMemoryInfo(readInfo);
      } catch (error) {
        usage.read = { error: error.message };
      }

      // 각 읽기 복제본 메모리 사용량
      for (let i = 0; i < this.readReplicas.length; i++) {
        try {
          const client = this.readReplicas[i];
          const info = await client.info('memory');
          usage.replicas[i] = this.parseDetailedMemoryInfo(info);
        } catch (error) {
          usage.replicas[i] = { error: error.message };
        }
      }

      return {
        ...usage,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('[MemoryUsage] Error:', error);
      return { error: error.message };
    }
  }

  // 상세 메모리 정보 파싱
  parseDetailedMemoryInfo(info) {
    try {
      const lines = info.split('\r\n');
      const memory = {};
      
      const importantKeys = [
        'used_memory',
        'used_memory_human',
        'used_memory_rss',
        'used_memory_rss_human',
        'used_memory_peak',
        'used_memory_peak_human',
        'maxmemory',
        'maxmemory_human'
      ];

      lines.forEach(line => {
        if (line.includes(':')) {
          const [key, value] = line.split(':');
          if (importantKeys.includes(key)) {
            memory[key] = value;
          }
        }
      });

      // 메모리 사용률 계산
      if (memory.used_memory && memory.maxmemory && memory.maxmemory !== '0') {
        const used = parseInt(memory.used_memory);
        const max = parseInt(memory.maxmemory);
        memory.usage_percentage = ((used / max) * 100).toFixed(2) + '%';
      }

      return memory;
    } catch (error) {
      return { error: 'Failed to parse detailed memory info' };
    }
  }

  // 성능 벤치마크
  async runBenchmark(operations = 1000) {
    console.log(`[Benchmark] Starting benchmark with ${operations} operations...`);
    
    const results = {
      write: { operations: 0, totalTime: 0, avgTime: 0, errors: 0 },
      read: { operations: 0, totalTime: 0, avgTime: 0, errors: 0 },
      timestamp: Date.now()
    };

    // 쓰기 벤치마크
    console.log('[Benchmark] Testing write operations...');
    const writeStart = Date.now();
    
    for (let i = 0; i < operations; i++) {
      try {
        const key = `benchmark:write:${i}`;
        const value = { data: `test_data_${i}`, timestamp: Date.now() };
        await this.writeThrough(key, value, 60); // 1분 TTL
        results.write.operations++;
      } catch (error) {
        results.write.errors++;
      }
    }
    
    results.write.totalTime = Date.now() - writeStart;
    results.write.avgTime = results.write.totalTime / results.write.operations;

    // 읽기 벤치마크
    console.log('[Benchmark] Testing read operations...');
    const readStart = Date.now();
    
    for (let i = 0; i < operations; i++) {
      try {
        const key = `benchmark:write:${i}`;
        await this.readFromShard(key);
        results.read.operations++;
      } catch (error) {
        results.read.errors++;
      }
    }
    
    results.read.totalTime = Date.now() - readStart;
    results.read.avgTime = results.read.totalTime / results.read.operations;

    // 정리
    console.log('[Benchmark] Cleaning up benchmark data...');
    await this.deletePattern('benchmark:write:*');

    console.log(`[Benchmark] Completed - Write: ${results.write.avgTime.toFixed(2)}ms avg, Read: ${results.read.avgTime.toFixed(2)}ms avg`);
    return results;
  }

  // 캐시 워밍업 (개선된 버전)
  async warmupCache(roomId, data) {
    try {
      const shard = this.getShardKey(roomId);
      console.log(`[Warmup] Warming cache for room ${roomId} on shard ${shard}`);
      
      const warmupData = [];

      // 기본 데이터 준비
      if (data.room) {
        warmupData.push({ key: `room:${roomId}`, value: data.room });
      }
      
      if (data.participants) {
        warmupData.push({ key: `participants:${roomId}`, value: data.participants });
      }
      
      if (data.recentMessages) {
        warmupData.push({ key: `recent:${roomId}`, value: data.recentMessages });
      }
      
      if (data.firstPageMessages) {
        warmupData.push({ 
          key: `messages:${roomId}:0`, 
          value: {
            messages: data.firstPageMessages,
            hasMore: data.hasMore || false,
            oldestTimestamp: data.firstPageMessages[0]?.timestamp || null,
            cachedAt: Date.now()
          }
        });
      }

      if (data.messageCount) {
        warmupData.push({ key: `msg_count:${roomId}`, value: data.messageCount });
      }

      // 배치로 캐시 저장
      if (warmupData.length > 0) {
        await this.mset(warmupData, 1800); // 30분 TTL
        console.log(`[Warmup] Warmed up ${warmupData.length} keys for room ${roomId}`);
      }

      return {
        roomId,
        shard,
        keysWarmedUp: warmupData.length,
        keys: warmupData.map(d => d.key),
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('[Warmup] Error:', error);
      throw error;
    }
  }

  // 배치 워밍업 (여러 방 동시)
  async batchWarmupCache(roomsData) {
    try {
      console.log(`[BatchWarmup] Starting warmup for ${roomsData.length} rooms`);
      
      const results = await Promise.allSettled(
        roomsData.map(({ roomId, data }) => this.warmupCache(roomId, data))
      );

      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      console.log(`[BatchWarmup] Completed - Success: ${successful}, Failed: ${failed}`);
      
      return {
        total: roomsData.length,
        successful,
        failed,
        results: results.map((result, index) => ({
          roomId: roomsData[index].roomId,
          status: result.status,
          value: result.status === 'fulfilled' ? result.value : null,
          error: result.status === 'rejected' ? result.reason?.message : null
        })),
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('[BatchWarmup] Error:', error);
      throw error;
    }
  }

  // 캐시 워밍업
  async warmupCache(roomId, data) {
    try {
      const shard = this.getShardKey(roomId);
      console.log(`[Warmup] Warming cache for room ${roomId} on shard ${shard}`);
      
      // 여러 관련 키들을 한번에 워밍업
      const warmupData = [
        { key: `room:${roomId}`, value: data.room },
        { key: `participants:${roomId}`, value: data.participants },
        { key: `recent:${roomId}`, value: data.recentMessages },
        { key: `messages:${roomId}:0`, value: data.firstPageMessages }
      ].filter(item => item.value !== undefined);
      
      await this.mset(warmupData, 1800); // 30분 TTL
      
      console.log(`[Warmup] Warmed up ${warmupData.length} keys for room ${roomId}`);
    } catch (error) {
      console.error('[Warmup] Error:', error);
    }
  }

  // 연결 모니터링 및 자동 복구
  async startConnectionMonitoring(intervalMs = 30000) {
    console.log('[Monitor] Starting connection monitoring...');
    
    this.monitoringInterval = setInterval(async () => {
      try {
        const health = await this.healthCheck();
        
        // 문제가 있는 연결 찾기
        if (!health.writeCluster) {
          console.error('[Monitor] Write cluster connection lost, attempting reconnection...');
          await this.reconnectWriteCluster();
        }

        if (!health.readCluster) {
          console.error('[Monitor] Read cluster connection lost, attempting reconnection...');
          await this.reconnectReadCluster();
        }

        // 읽기 복제본 상태 확인
        health.readReplicas.forEach(async (status, index) => {
          if (!status) {
            console.error(`[Monitor] Read replica ${index} connection lost, attempting reconnection...`);
            await this.reconnectReadReplica(index);
          }
        });

      } catch (error) {
        console.error('[Monitor] Monitoring error:', error);
      }
    }, intervalMs);
  }

  // 모니터링 중지
  stopConnectionMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      console.log('[Monitor] Connection monitoring stopped');
    }
  }

  // 쓰기 클러스터 재연결
  async reconnectWriteCluster() {
    try {
      await this.clusters.write.disconnect();
      this.clusters.write = new Redis.Cluster([
        { host: 'redis-write-1', port: 6379 },
        { host: 'redis-write-2', port: 6379 },
        { host: 'redis-write-3', port: 6379 }
      ], {
        enableReadyCheck: false,
        redisOptions: {
          password: process.env.REDIS_PASSWORD,
          retryDelayOnFailover: 100,
          maxRetriesPerRequest: 3
        }
      });
      
      console.log('[Reconnect] Write cluster reconnected successfully');
    } catch (error) {
      console.error('[Reconnect] Write cluster reconnection failed:', error);
    }
  }

  // 읽기 클러스터 재연결
  async reconnectReadCluster() {
    try {
      await this.clusters.read.disconnect();
      this.clusters.read = new Redis.Cluster([
        { host: 'redis-read-1', port: 6379 },
        { host: 'redis-read-2', port: 6379 },
        { host: 'redis-read-3', port: 6379 }
      ], {
        enableReadyCheck: false,
        redisOptions: {
          password: process.env.REDIS_PASSWORD,
          retryDelayOnFailover: 100,
          maxRetriesPerRequest: 3
        }
      });
      
      console.log('[Reconnect] Read cluster reconnected successfully');
    } catch (error) {
      console.error('[Reconnect] Read cluster reconnection failed:', error);
    }
  }

  // 읽기 복제본 재연결
  async reconnectReadReplica(index) {
    try {
      const hosts = ['redis-slave-1', 'redis-slave-2', 'redis-slave-3'];
      
      if (index < this.readReplicas.length) {
        await this.readReplicas[index].disconnect();
        this.readReplicas[index] = new Redis({
          host: hosts[index],
          port: 6379,
          password: process.env.REDIS_PASSWORD,
          retryDelayOnFailover: 100,
          maxRetriesPerRequest: 3
        });
        
        console.log(`[Reconnect] Read replica ${index} reconnected successfully`);
      }
    } catch (error) {
      console.error(`[Reconnect] Read replica ${index} reconnection failed:`, error);
    }
  }

  // 성능 최적화를 위한 파이프라인 실행
  async executePipeline(operations, cluster = 'write') {
    try {
      const client = cluster === 'write' ? this.clusters.write : this.clusters.read;
      const pipeline = client.pipeline();
      
      // 작업들을 파이프라인에 추가
      operations.forEach(op => {
        switch (op.command) {
          case 'set':
            pipeline.set(op.key, op.value);
            break;
          case 'setEx':
            pipeline.setEx(op.key, op.ttl, op.value);
            break;
          case 'get':
            pipeline.get(op.key);
            break;
          case 'del':
            pipeline.del(op.key);
            break;
          case 'exists':
            pipeline.exists(op.key);
            break;
          default:
            console.warn(`[Pipeline] Unknown command: ${op.command}`);
        }
      });
      
      const results = await pipeline.exec();
      console.log(`[Pipeline] Executed ${operations.length} operations`);
      
      return results.map((result, index) => ({
        operation: operations[index],
        success: result[0] === null,
        result: result[1],
        error: result[0]
      }));
      
    } catch (error) {
      console.error('[Pipeline] Execution error:', error);
      throw error;
    }
  }

  // 캐시 정리 스케줄러
  startCacheCleanup(intervalMs = 3600000) { // 1시간마다
    console.log('[Cleanup] Starting cache cleanup scheduler...');
    
    this.cleanupInterval = setInterval(async () => {
      try {
        console.log('[Cleanup] Starting scheduled cache cleanup...');
        
        // 만료된 키들 정리 (Redis에서 자동으로 하지만 명시적으로 실행)
        const patterns = [
          'messages:*',
          'room:*',
          'recent:*',
          'user:*'
        ];

        let totalCleaned = 0;
        
        for (const pattern of patterns) {
          try {
            // 각 읽기 노드에서 만료 가능성이 높은 키들 확인
            for (const client of this.readReplicas) {
              const keys = await client.keys(pattern);
              
              // TTL이 매우 짧은 키들 확인
              const expiringSoon = [];
              for (const key of keys.slice(0, 100)) { // 성능을 위해 최대 100개씩
                const ttl = await client.ttl(key);
                if (ttl > 0 && ttl < 60) { // 1분 미만 남은 키들
                  expiringSoon.push(key);
                }
              }
              
              if (expiringSoon.length > 0) {
                console.log(`[Cleanup] Found ${expiringSoon.length} keys expiring soon for pattern ${pattern}`);
              }
            }
          } catch (error) {
            console.error(`[Cleanup] Error processing pattern ${pattern}:`, error);
          }
        }

        console.log(`[Cleanup] Cleanup completed. Total processed: ${totalCleaned}`);
        
      } catch (error) {
        console.error('[Cleanup] Scheduled cleanup error:', error);
      }
    }, intervalMs);
  }

  // 정리 스케줄러 중지
  stopCacheCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      console.log('[Cleanup] Cache cleanup scheduler stopped');
    }
  }

  // 응급 상황 시 모든 캐시 플러시
  async emergencyFlush() {
    console.warn('[Emergency] Starting emergency cache flush...');
    
    try {
      // 모든 클러스터와 복제본에서 플러시
      await this.clusters.write.flushall();
      await this.clusters.read.flushall();
      
      for (let i = 0; i < this.readReplicas.length; i++) {
        try {
          await this.readReplicas[i].flushall();
        } catch (error) {
          console.error(`[Emergency] Failed to flush replica ${i}:`, error);
        }
      }
      
      console.warn('[Emergency] Emergency cache flush completed');
      return { success: true, timestamp: Date.now() };
      
    } catch (error) {
      console.error('[Emergency] Emergency flush failed:', error);
      return { success: false, error: error.message, timestamp: Date.now() };
    }
  }

  // 전체 시스템 상태 대시보드 정보
  async getDashboardInfo() {
    try {
      const [
        health,
        stats,
        memory,
        hitRatio,
        keyDistribution,
        clusterInfo
      ] = await Promise.allSettled([
        this.healthCheck(),
        this.getStats(),
        this.getMemoryUsage(),
        this.getCacheHitRatio(),
        this.getKeyDistribution(),
        this.getClusterInfo()
      ]);

      return {
        health: health.status === 'fulfilled' ? health.value : { error: health.reason?.message },
        stats: stats.status === 'fulfilled' ? stats.value : { error: stats.reason?.message },
        memory: memory.status === 'fulfilled' ? memory.value : { error: memory.reason?.message },
        hitRatio: hitRatio.status === 'fulfilled' ? hitRatio.value : { error: hitRatio.reason?.message },
        keyDistribution: keyDistribution.status === 'fulfilled' ? keyDistribution.value : { error: keyDistribution.reason?.message },
        clusterInfo: clusterInfo.status === 'fulfilled' ? clusterInfo.value : { error: clusterInfo.reason?.message },
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('[Dashboard] Error getting dashboard info:', error);
      return { error: error.message, timestamp: Date.now() };
    }
  }

  // 연결 종료 (개선된 버전)
  async disconnect() {
    try {
      console.log('[Redis] Starting graceful shutdown...');
      
      // 모니터링 중지
      this.stopConnectionMonitoring();
      this.stopCacheCleanup();
      
      // 클러스터 연결 종료
      await Promise.allSettled([
        this.clusters.write.disconnect(),
        this.clusters.read.disconnect()
      ]);
      
      // 읽기 복제본 연결 종료
      await Promise.allSettled(
        this.readReplicas.map(client => client.disconnect())
      );
      
      console.log('[Redis] All connections closed gracefully');
      return { success: true, timestamp: Date.now() };
      
    } catch (error) {
      console.error('[Redis] Error during disconnect:', error);
      return { success: false, error: error.message, timestamp: Date.now() };
    }
  }
}

module.exports = new RedisShardingService();