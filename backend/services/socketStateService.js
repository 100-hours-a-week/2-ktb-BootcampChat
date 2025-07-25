const redisClient = require('../utils/redisClient');

class SocketStateService {
  // Redis 키 접두사
  static CONNECTED_USERS_PREFIX = 'socket:connected_users:';
  static STREAMING_SESSIONS_PREFIX = 'socket:streaming_sessions:';
  static USER_ROOMS_PREFIX = 'socket:user_rooms:';
  static MESSAGE_QUEUES_PREFIX = 'socket:message_queues:';
  static MESSAGE_RETRIES_PREFIX = 'socket:message_retries:';
  static ROOM_USERS_PREFIX = 'socket:room_users:';

  // TTL 설정 (초)
  static DEFAULT_TTL = 24 * 60 * 60; // 24시간
  static QUEUE_TTL = 60 * 60; // 1시간
  static SESSION_TTL = 2 * 60 * 60; // 2시간

  // === 연결된 사용자 관리 ===
  static async setConnectedUser(userId, socketId) {
    try {
      const key = `${this.CONNECTED_USERS_PREFIX}${userId}`;
      await redisClient.setEx(key, this.DEFAULT_TTL, socketId);
      return true;
    } catch (error) {
      console.error('Error setting connected user:', error);
      return false;
    }
  }

  static async getConnectedUser(userId) {
    try {
      const key = `${this.CONNECTED_USERS_PREFIX}${userId}`;
      return await redisClient.get(key);
    } catch (error) {
      console.error('Error getting connected user:', error);
      return null;
    }
  }

  static async removeConnectedUser(userId) {
    try {
      const key = `${this.CONNECTED_USERS_PREFIX}${userId}`;
      await redisClient.del(key);
      return true;
    } catch (error) {
      console.error('Error removing connected user:', error);
      return false;
    }
  }

  // === 스트리밍 세션 관리 ===
  static async setStreamingSession(messageId, sessionData) {
    try {
      const key = `${this.STREAMING_SESSIONS_PREFIX}${messageId}`;
      await redisClient.setEx(key, this.SESSION_TTL, sessionData);
      return true;
    } catch (error) {
      console.error('Error setting streaming session:', error);
      return false;
    }
  }

  static async getStreamingSession(messageId) {
    try {
      const key = `${this.STREAMING_SESSIONS_PREFIX}${messageId}`;
      return await redisClient.get(key);
    } catch (error) {
      console.error('Error getting streaming session:', error);
      return null;
    }
  }

  static async updateStreamingSession(messageId, updates) {
    try {
      const session = await this.getStreamingSession(messageId);
      if (!session) return false;

      const updatedSession = { ...session, ...updates };
      return await this.setStreamingSession(messageId, updatedSession);
    } catch (error) {
      console.error('Error updating streaming session:', error);
      return false;
    }
  }

  static async removeStreamingSession(messageId) {
    try {
      const key = `${this.STREAMING_SESSIONS_PREFIX}${messageId}`;
      await redisClient.del(key);
      return true;
    } catch (error) {
      console.error('Error removing streaming session:', error);
      return false;
    }
  }

  static async getStreamingSessionsByRoom(roomId) {
    try {
      const pattern = `${this.STREAMING_SESSIONS_PREFIX}*`;
      const keys = await redisClient.keys(pattern);
      
      const sessions = [];
      for (const key of keys) {
        const session = await redisClient.get(key);
        if (session && session.room === roomId) {
          const messageId = key.replace(this.STREAMING_SESSIONS_PREFIX, '');
          sessions.push({
            messageId,
            ...session
          });
        }
      }
      
      return sessions;
    } catch (error) {
      console.error('Error getting streaming sessions by room:', error);
      return [];
    }
  }

  static async removeStreamingSessionsByUser(userId) {
    try {
      const pattern = `${this.STREAMING_SESSIONS_PREFIX}*`;
      const keys = await redisClient.keys(pattern);
      
      for (const key of keys) {
        const session = await redisClient.get(key);
        if (session && session.userId === userId) {
          await redisClient.del(key);
        }
      }
      
      return true;
    } catch (error) {
      console.error('Error removing streaming sessions by user:', error);
      return false;
    }
  }

  static async removeStreamingSessionsByRoomAndUser(roomId, userId) {
    try {
      const pattern = `${this.STREAMING_SESSIONS_PREFIX}*`;
      const keys = await redisClient.keys(pattern);
      
      for (const key of keys) {
        const session = await redisClient.get(key);
        if (session && session.room === roomId && session.userId === userId) {
          await redisClient.del(key);
        }
      }
      
      return true;
    } catch (error) {
      console.error('Error removing streaming sessions by room and user:', error);
      return false;
    }
  }

  // === 사용자 방 관리 ===
  static async setUserRoom(userId, roomId) {
    try {
      const key = `${this.USER_ROOMS_PREFIX}${userId}`;
      await redisClient.setEx(key, this.DEFAULT_TTL, roomId);
      return true;
    } catch (error) {
      console.error('Error setting user room:', error);
      return false;
    }
  }

  static async getUserRoom(userId) {
    try {
      const key = `${this.USER_ROOMS_PREFIX}${userId}`;
      return await redisClient.get(key);
    } catch (error) {
      console.error('Error getting user room:', error);
      return null;
    }
  }

  static async removeUserRoom(userId) {
    try {
      const key = `${this.USER_ROOMS_PREFIX}${userId}`;
      await redisClient.del(key);
      return true;
    } catch (error) {
      console.error('Error removing user room:', error);
      return false;
    }
  }

  // === 메시지 큐 관리 ===
  static async setMessageQueue(queueKey, value = true) {
    try {
      const key = `${this.MESSAGE_QUEUES_PREFIX}${queueKey}`;
      await redisClient.setEx(key, this.QUEUE_TTL, value);
      return true;
    } catch (error) {
      console.error('Error setting message queue:', error);
      return false;
    }
  }

  static async getMessageQueue(queueKey) {
    try {
      const key = `${this.MESSAGE_QUEUES_PREFIX}${queueKey}`;
      return await redisClient.get(key);
    } catch (error) {
      console.error('Error getting message queue:', error);
      return null;
    }
  }

  static async removeMessageQueue(queueKey) {
    try {
      const key = `${this.MESSAGE_QUEUES_PREFIX}${queueKey}`;
      await redisClient.del(key);
      return true;
    } catch (error) {
      console.error('Error removing message queue:', error);
      return false;
    }
  }

  static async removeMessageQueuesByUser(userId) {
    try {
      const pattern = `${this.MESSAGE_QUEUES_PREFIX}*:${userId}`;
      const keys = await redisClient.keys(pattern);
      
      for (const key of keys) {
        await redisClient.del(key);
      }
      
      return true;
    } catch (error) {
      console.error('Error removing message queues by user:', error);
      return false;
    }
  }

  // === 메시지 재시도 관리 ===
  static async setMessageRetry(queueKey, retryCount) {
    try {
      const key = `${this.MESSAGE_RETRIES_PREFIX}${queueKey}`;
      await redisClient.setEx(key, this.QUEUE_TTL, retryCount);
      return true;
    } catch (error) {
      console.error('Error setting message retry:', error);
      return false;
    }
  }

  static async getMessageRetry(queueKey) {
    try {
      const key = `${this.MESSAGE_RETRIES_PREFIX}${queueKey}`;
      const result = await redisClient.get(key);
      return result ? parseInt(result) : 0;
    } catch (error) {
      console.error('Error getting message retry:', error);
      return 0;
    }
  }

  static async removeMessageRetry(queueKey) {
    try {
      const key = `${this.MESSAGE_RETRIES_PREFIX}${queueKey}`;
      await redisClient.del(key);
      return true;
    } catch (error) {
      console.error('Error removing message retry:', error);
      return false;
    }
  }

  static async removeMessageRetriesByUser(userId) {
    try {
      const pattern = `${this.MESSAGE_RETRIES_PREFIX}*:${userId}`;
      const keys = await redisClient.keys(pattern);
      
      for (const key of keys) {
        await redisClient.del(key);
      }
      
      return true;
    } catch (error) {
      console.error('Error removing message retries by user:', error);
      return false;
    }
  }

  // === 방 사용자 관리 (Set 기반) ===
  static async addUserToRoom(roomId, userId) {
    try {
      const key = `${this.ROOM_USERS_PREFIX}${roomId}`;
      await redisClient.sadd(key, userId);
      await redisClient.expire(key, this.DEFAULT_TTL);
      return true;
    } catch (error) {
      console.error('Error adding user to room:', error);
      return false;
    }
  }

  static async removeUserFromRoom(roomId, userId) {
    try {
      const key = `${this.ROOM_USERS_PREFIX}${roomId}`;
      await redisClient.srem(key, userId);
      return true;
    } catch (error) {
      console.error('Error removing user from room:', error);
      return false;
    }
  }

  static async getRoomUsers(roomId) {
    try {
      const key = `${this.ROOM_USERS_PREFIX}${roomId}`;
      return await redisClient.smembers(key);
    } catch (error) {
      console.error('Error getting room users:', error);
      return [];
    }
  }

  static async isUserInRoom(roomId, userId) {
    try {
      const key = `${this.ROOM_USERS_PREFIX}${roomId}`;
      return await redisClient.sismember(key, userId);
    } catch (error) {
      console.error('Error checking if user in room:', error);
      return false;
    }
  }

  // === 정리 함수들 ===
  static async cleanupUserData(userId) {
    try {
      await Promise.all([
        this.removeConnectedUser(userId),
        this.removeUserRoom(userId),
        this.removeStreamingSessionsByUser(userId),
        this.removeMessageQueuesByUser(userId),
        this.removeMessageRetriesByUser(userId)
      ]);
      
      return true;
    } catch (error) {
      console.error('Error cleaning up user data:', error);
      return false;
    }
  }

  static async cleanupRoomData(roomId, userId) {
    try {
      await Promise.all([
        this.removeUserFromRoom(roomId, userId),
        this.removeStreamingSessionsByRoomAndUser(roomId, userId)
      ]);
      
      return true;
    } catch (error) {
      console.error('Error cleaning up room data:', error);
      return false;
    }
  }

  // === 헬스 체크 ===
  static async healthCheck() {
    try {
      const testKey = 'socket:health:test';
      const testValue = Date.now().toString();
      
      await redisClient.setEx(testKey, 10, testValue);
      const result = await redisClient.get(testKey);
      await redisClient.del(testKey);
      
      return result === testValue;
    } catch (error) {
      console.error('Socket state service health check failed:', error);
      return false;
    }
  }
}

module.exports = SocketStateService;
