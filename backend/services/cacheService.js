// services/cacheService.js
const redisClient = require('../utils/redisClient');

class CacheService {
  constructor() {
    this.TTL = {
      MESSAGES: 3600,        // 메시지 캐시 1시간
      ROOM_INFO: 1800,       // 채팅방 정보 30분
      USER_ROOMS: 1800,      // 사용자-방 매핑 30분
      MESSAGE_BATCH: 600,    // 메시지 배치 10분
      RECENT_MESSAGES: 300   // 최근 메시지 5분
    };
    this.MAX_CACHED_MESSAGES = 50; // 최근 메시지 캐시에 저장할 최대 메시지 수
    
    this.KEYS = {
      MESSAGES: (roomId, page = 0) => `messages:${roomId}:${page}`,
      ROOM_INFO: (roomId) => `room:${roomId}`,
      USER_ROOMS: (userId) => `user_rooms:${userId}`,
      ROOM_PARTICIPANTS: (roomId) => `participants:${roomId}`,
      RECENT_MESSAGES: (roomId) => `recent:${roomId}`,
      MESSAGE_COUNT: (roomId) => `msg_count:${roomId}`,
      UNREAD_COUNT: (userId, roomId) => `unread:${userId}:${roomId}`
    };
  }

  async ensureClient() {
    if (!redisClient.client) {
      await redisClient.connect();
    }
  }

  // 메시지 배치 캐싱 (페이지네이션 기반)
  async cacheMessageBatch(roomId, messages, page = 0, hasMore = false) {
    try {
      const key = this.KEYS.MESSAGES(roomId, page);
      const cacheData = {
        messages,
        hasMore,
        timestamp: Date.now(),
        oldestTimestamp: messages[0]?.timestamp || null
      };
      
      await redisClient.setEx(key, this.TTL.MESSAGE_BATCH, JSON.stringify(cacheData));
      
      // 최근 메시지도 별도 캐싱 (실시간 업데이트용)
      if (page === 0) {
        await this.cacheRecentMessages(roomId, messages.slice(-20)); // 최근 20개
      }
      
      console.log(`[Cache] Messages cached for room ${roomId}, page ${page}`);
    } catch (error) {
      console.error('[Cache] Message batch caching error:', error);
    }
  }

  async getCachedMessageBatch(roomId, page = 0) {
    try {
      const key = this.KEYS.MESSAGES(roomId, page);
      const cached = await redisClient.get(key);
      
      if (!cached) {
        console.log(`[Cache] Messages cache miss for room ${roomId}, page ${page}`);
        return null;
      }
      
      // 이미 객체인 경우 (MockRedis에서 파싱된 경우)
      if (typeof cached === 'object') {
        console.log(`[Cache] Messages cache hit for room ${roomId}, page ${page}`);
        return cached;
      }
      
      // 문자열인 경우 파싱 시도
      if (typeof cached === 'string') {
        // "[object Object]" 같은 잘못된 데이터 체크
        if (cached === '[object Object]' || cached.startsWith('[object ')) {
          console.warn(`[Cache] Corrupted message data found for room ${roomId}, page ${page}, removing`);
          await redisClient.del(key);
          return null;
        }
        
        try {
          const data = JSON.parse(cached);
          console.log(`[Cache] Messages cache hit for room ${roomId}, page ${page}`);
          return data;
        } catch (parseError) {
          console.warn(`[Cache] Failed to parse message data for room ${roomId}, page ${page}:`, cached);
          await redisClient.del(key); // 잘못된 데이터 삭제
          return null;
        }
      }
      
      console.log(`[Cache] Messages cache miss for room ${roomId}, page ${page}`);
      return null;
    } catch (error) {
      console.error('[Cache] Message batch retrieval error:', error);
      return null;
    }
  }

  // 최근 메시지 캐싱 (실시간 업데이트용)
  async cacheRecentMessages(roomId, messages) {
    try {
      const key = this.KEYS.RECENT_MESSAGES(roomId);
      await redisClient.setEx(key, this.TTL.RECENT_MESSAGES, JSON.stringify(messages));
    } catch (error) {
      console.error('[Cache] Recent messages caching error:', error);
    }
  }

  async getRecentMessages(roomId) {
    try {
      const key = this.KEYS.RECENT_MESSAGES(roomId);
      const cached = await redisClient.get(key);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error('[Cache] Recent messages retrieval error:', error);
      return null;
    }
  }

  // 새 메시지 추가 시 캐시 업데이트
  // async addMessageToCache(roomId, message, maxRecentMessages = 20) {
  //   try {
  //     // 최근 메시지 캐시 업데이트
  //     const recentKey = this.KEYS.RECENT_MESSAGES(roomId);
  //     const recent = await redisClient.get(recentKey);
      
  //     if (recent) {
  //       const messages = JSON.parse(recent);
  //       messages.push(message);
        
  //       // 최대 개수 제한
  //       if (messages.length > maxRecentMessages) {
  //         messages.shift();
  //       }
        
  //       await redisClient.setEx(recentKey, this.TTL.RECENT_MESSAGES, JSON.stringify(messages));
  //     }

  //     // 첫 페이지 캐시 무효화 (새 메시지로 인한 변경)
  //     await this.invalidateMessageBatch(roomId, 0);
      
  //     console.log(`[Cache] Message added to cache for room ${roomId}`);
  //   } catch (error) {
  //     console.error('[Cache] Add message to cache error:', error);
  //   }
  // }

  async addMessageToCache(roomId, message) {
    try {
      const key = this.KEYS.RECENT_MESSAGES(roomId);
      const cached = await redisClient.get(key);
      
      let messages = [];
      if (Array.isArray(cached)) {
        messages = cached;
      } else if (cached) {
        console.warn(`[Cache] Unexpected data format for recent messages in room ${roomId}, starting fresh.`);
      }
      
      messages.push(message);
      if (messages.length > this.MAX_CACHED_MESSAGES) {
        messages = messages.slice(-this.MAX_CACHED_MESSAGES);
      }
      
      // redisClient는 자동으로 객체를 JSON 문자열로 변환하지만, 명시적으로 처리하는 것이 안전합니다.
      await redisClient.setEx(key, this.TTL.RECENT_MESSAGES, JSON.stringify(messages));

      // 첫 페이지 캐시 무효화 (가장 중요!)
      // 새 메시지가 추가되었으므로, 재접속 시 최신 데이터를 불러오도록 페이지 0의 캐시를 삭제합니다.
      await this.invalidateMessageBatch(roomId, 0);
      console.log(`[Cache] Message added and batch invalidated for room ${roomId}`);
    } catch (error) {
      console.error('[Cache] Add message to cache error:', error);
    }
  }

  // 채팅방 정보 캐싱
  async cacheRoomInfo(roomId, roomData) {
    try {
      const key = this.KEYS.ROOM_INFO(roomId);
      await redisClient.setEx(key, this.TTL.ROOM_INFO, JSON.stringify(roomData));
      
      // 참가자 정보도 별도 캐싱
      if (roomData.participants) {
        const participantsKey = this.KEYS.ROOM_PARTICIPANTS(roomId);
        await redisClient.setEx(participantsKey, this.TTL.ROOM_INFO, JSON.stringify(roomData.participants));
      }
    } catch (error) {
      console.error('[Cache] Room info caching error:', error);
    }
  }

  async getCachedRoomInfo(roomId) {
    try {
      const key = this.KEYS.ROOM_INFO(roomId);
      const cached = await redisClient.get(key);
      
      if (!cached) return null;
      
      // 이미 객체인 경우 (MockRedis에서 파싱된 경우)
      if (typeof cached === 'object') {
        return cached;
      }
      
      // 문자열인 경우 파싱 시도
      if (typeof cached === 'string') {
        // "[object Object]" 같은 잘못된 데이터 체크
        if (cached === '[object Object]' || cached.startsWith('[object ')) {
          console.warn(`[Cache] Corrupted data found for key ${key}, removing`);
          await redisClient.del(key);
          return null;
        }
        
        try {
          return JSON.parse(cached);
        } catch (parseError) {
          console.warn(`[Cache] Failed to parse cached data for key ${key}:`, cached);
          await redisClient.del(key); // 잘못된 데이터 삭제
          return null;
        }
      }
      
      return null;
    } catch (error) {
      console.error('[Cache] Room info retrieval error:', error);
      return null;
    }
  }

  async getCachedParticipants(roomId) {
    try {
      const key = this.KEYS.ROOM_PARTICIPANTS(roomId);
      const cached = await redisClient.get(key);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error('[Cache] Participants retrieval error:', error);
      return null;
    }
  }

  // 사용자의 참여 방 정보 캐싱
  async cacheUserRooms(userId, roomIds) {
    try {
      const key = this.KEYS.USER_ROOMS(userId);
      await redisClient.setEx(key, this.TTL.USER_ROOMS, JSON.stringify(roomIds));
    } catch (error) {
      console.error('[Cache] User rooms caching error:', error);
    }
  }

  async getCachedUserRooms(userId) {
    try {
      const key = this.KEYS.USER_ROOMS(userId);
      const cached = await redisClient.get(key);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      console.error('[Cache] User rooms retrieval error:', error);
      return null;
    }
  }

  // 메시지 수 캐싱
  async cacheMessageCount(roomId, count) {
    try {
      const key = this.KEYS.MESSAGE_COUNT(roomId);
      await redisClient.setEx(key, this.TTL.ROOM_INFO, count.toString());
    } catch (error) {
      console.error('[Cache] Message count caching error:', error);
    }
  }

  async getCachedMessageCount(roomId) {
    try {
      const key = this.KEYS.MESSAGE_COUNT(roomId);
      const cached = await redisClient.get(key);
      return cached ? parseInt(cached) : null;
    } catch (error) {
      console.error('[Cache] Message count retrieval error:', error);
      return null;
    }
  }

  // 읽지 않은 메시지 수 캐싱
  async cacheUnreadCount(userId, roomId, count) {
    try {
      const key = this.KEYS.UNREAD_COUNT(userId, roomId);
      await redisClient.setEx(key, this.TTL.ROOM_INFO, count.toString());
    } catch (error) {
      console.error('[Cache] Unread count caching error:', error);
    }
  }

  async getCachedUnreadCount(userId, roomId) {
    try {
      const key = this.KEYS.UNREAD_COUNT(userId, roomId);
      const cached = await redisClient.get(key);
      return cached ? parseInt(cached) : null;
    } catch (error) {
      console.error('[Cache] Unread count retrieval error:', error);
      return null;
    }
  }

  // 캐시 무효화 메서드들
  async invalidateMessageBatch(roomId, page) {
    try {
      const key = this.KEYS.MESSAGES(roomId, page);
      await redisClient.del(key);
      console.log(`[Cache] Invalidated message batch for room ${roomId}, page ${page}`);
    } catch (error) {
      console.error('[Cache] Message batch invalidation error:', error);
    }
  }

  async invalidateRoomCache(roomId) {
    try {
      const keys = [
        this.KEYS.ROOM_INFO(roomId),
        this.KEYS.ROOM_PARTICIPANTS(roomId),
        this.KEYS.RECENT_MESSAGES(roomId),
        this.KEYS.MESSAGE_COUNT(roomId)
      ];
      
      // 모든 페이지의 메시지 캐시도 무효화 (최대 10페이지 가정)
      for (let i = 0; i < 10; i++) {
        keys.push(this.KEYS.MESSAGES(roomId, i));
      }
      
      await redisClient.del(...keys);
      console.log(`[Cache] Invalidated all cache for room ${roomId}`);
    } catch (error) {
      console.error('[Cache] Room cache invalidation error:', error);
    }
  }

  async invalidateUserCache(userId) {
    try {
      await this.ensureClient();
      const keys = [this.KEYS.USER_ROOMS(userId)];
      const pattern = this.KEYS.UNREAD_COUNT(userId, '*');
      const unreadKeys = redisClient.useMock
        ? Array.from(redisClient.client.store.keys()).filter((key) =>
            new RegExp('^' + pattern.replace(/\*/g, '.*') + '$').test(key)
          )
        : await redisClient.client.keys(pattern);

      keys.push(...unreadKeys);

      if (keys.length > 0) {
        await redisClient.del(...keys);
      }
      console.log(`[Cache] Invalidated user cache for ${userId}`);
    } catch (error) {
      console.error('[Cache] User cache invalidation error:', error);
    }
  }

  // 배치 무효화 (여러 방의 캐시를 한번에 무효화)
  async invalidateMultipleRooms(roomIds) {
    try {
      const keys = [];
      
      for (const roomId of roomIds) {
        keys.push(
          this.KEYS.ROOM_INFO(roomId),
          this.KEYS.ROOM_PARTICIPANTS(roomId),
          this.KEYS.RECENT_MESSAGES(roomId),
          this.KEYS.MESSAGE_COUNT(roomId)
        );
        
        // 메시지 페이지 캐시들
        for (let i = 0; i < 10; i++) {
          keys.push(this.KEYS.MESSAGES(roomId, i));
        }
      }
      
      if (keys.length > 0) {
        await redisClient.del(...keys);
      }
      console.log(`[Cache] Invalidated cache for ${roomIds.length} rooms`);
    } catch (error) {
      console.error('[Cache] Multiple rooms cache invalidation error:', error);
    }
  }

  // 캐시 통계 조회
  async getCacheStats() {
    try {
      const info = await redisClient.info('memory');
      const keyspace = await redisClient.info('keyspace');
      
      return {
        memory: info,
        keyspace: keyspace,
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('[Cache] Stats retrieval error:', error);
      return null;
    }
  }

  // 캐시 워밍업 (자주 사용되는 데이터 미리 로드)
  async warmupCache(roomId, userId) {
    try {
      console.log(`[Cache] Warming up cache for room ${roomId}, user ${userId}`);
      
      // 최근 메시지 미리 로드 등의 로직
      // 실제 구현에서는 사용 패턴에 따라 적절히 조정
      
    } catch (error) {
      console.error('[Cache] Cache warmup error:', error);
    }
  }

  // cacheService.js에 추가
  async clearCorruptedCache() {
    try {
      console.log('[Cache] Starting corrupted cache cleanup...');
      await this.ensureClient();

      if (redisClient.useMock) {
        const store = redisClient.client.store;
        const keysToDelete = [];

        for (const [key, item] of store.entries()) {
          if (
            item.value === '[object Object]' ||
            (typeof item.value === 'string' && item.value.startsWith('[object '))
          ) {
            keysToDelete.push(key);
          }
        }

        keysToDelete.forEach((key) => {
          store.delete(key);
          console.log(`[Cache] Cleared corrupted mock cache key: ${key}`);
        });

        console.log(
          `[Cache] Cleanup complete. Removed ${keysToDelete.length} corrupted entries.`
        );
      } else {
        const keys = await redisClient.client.keys('*');
        let cleanedCount = 0;

        for (const key of keys) {
          try {
            const value = await redisClient.client.get(key);
            if (
              value === '[object Object]' ||
              (typeof value === 'string' && value.startsWith('[object '))
            ) {
              await redisClient.del(key);
              console.log(`[Cache] Cleared corrupted cache key: ${key}`);
              cleanedCount++;
            }
          } catch (error) {
            console.error(`[Cache] Error checking key ${key}:`, error);
          }
        }

        console.log(
          `[Cache] Cleanup complete. Removed ${cleanedCount} corrupted entries.`
        );
      }
    } catch (error) {
      console.error('[Cache] Cache cleanup error:', error);
    }
  }
}

module.exports = new CacheService();