// repositories/messageRepository.js
const Message = require('../models/Message');
const redisSharding = require('../utils/redisShardingService');
const cacheService = require('../services/cacheService');

class MessageRepository {
  constructor() {
    this.CACHE_TTL = {
      MESSAGES: 3600,        // 1시간
      MESSAGE_BATCH: 1800,   // 30분
      RECENT_MESSAGES: 600,  // 10분
      MESSAGE_COUNT: 7200    // 2시간
    };
  }

  // 메시지 저장 (Write-Through 패턴)
  async saveMessage(messageData) {
    try {
      // 1. MongoDB에 저장
      const message = new Message(messageData);
      await message.save();
      
      // populate 적용
      await message.populate([
        { path: 'sender', select: 'name email profileImage' },
        { path: 'file', select: 'filename originalname mimetype size' }
      ]);

      // 2. Redis 캐시에 저장 (Write-Through)
      const cacheKey = `message:${message._id}`;
      await redisSharding.writeThrough(cacheKey, message.toObject(), this.CACHE_TTL.MESSAGES);

      // 3. 최근 메시지 캐시 업데이트
      await this.addToRecentMessages(message.room.toString(), message.toObject());

      // 4. 메시지 카운트 증가
      await this.incrementMessageCount(message.room.toString());

      // 5. 첫 페이지 캐시 무효화
      await this.invalidateMessageBatch(message.room.toString(), 0);

      console.log(`[MessageRepo] Message saved and cached: ${message._id}`);
      return message;

    } catch (error) {
      console.error('[MessageRepo] Save error:', error);
      throw error;
    }
  }

  // 메시지 배치 조회 (캐시 우선)
  async getMessagesBatch(roomId, page = 0, limit = 30, before = null) {
    try {
      const cacheKey = `messages:${roomId}:${page}`;
      
      // 1. 캐시에서 먼저 조회
      let cached = await redisSharding.readFromShard(cacheKey);
      
      if (cached && (!before || this.isValidCacheForBefore(cached, before))) {
        console.log(`[MessageRepo] Cache hit for messages batch: ${cacheKey}`);
        return cached;
      }

      // 2. 캐시 미스 - DB에서 조회
      const query = { room: roomId };
      if (before) {
        query.timestamp = { $lt: new Date(before) };
      }

      const messages = await Message.find(query)
        .populate('sender', 'name email profileImage')
        .populate({
          path: 'file',
          select: 'filename originalname mimetype size'
        })
        .sort({ timestamp: -1 })
        .limit(limit + 1)
        .lean();

      // 3. 결과 처리
      const hasMore = messages.length > limit;
      const resultMessages = messages.slice(0, limit);
      const sortedMessages = resultMessages.sort((a, b) => 
        new Date(a.timestamp) - new Date(b.timestamp)
      );

      const result = {
        messages: sortedMessages,
        hasMore,
        oldestTimestamp: sortedMessages[0]?.timestamp || null,
        cachedAt: Date.now()
      };

      // 4. 결과를 캐시에 저장
      await redisSharding.writeThrough(cacheKey, result, this.CACHE_TTL.MESSAGE_BATCH);

      console.log(`[MessageRepo] Messages loaded from DB and cached: ${cacheKey}`);
      return result;

    } catch (error) {
      console.error('[MessageRepo] Get messages batch error:', error);
      throw error;
    }
  }

  // 최근 메시지 조회
  async getRecentMessages(roomId, limit = 20) {
    try {
      const cacheKey = `recent:${roomId}`;
      
      // 캐시에서 먼저 조회
      let recent = await redisSharding.readFromShard(cacheKey);
      
      if (recent && Array.isArray(recent) && recent.length > 0) {
        console.log(`[MessageRepo] Recent messages cache hit: ${roomId}`);
        return recent.slice(-limit); // 최신 limit개만 반환
      }

      // 캐시 미스 - DB에서 조회
      const messages = await Message.find({ room: roomId })
        .populate('sender', 'name email profileImage')
        .populate({
          path: 'file',
          select: 'filename originalname mimetype size'
        })
        .sort({ timestamp: -1 })
        .limit(limit)
        .lean();

      const sortedMessages = messages.reverse(); // 시간순 정렬

      // 캐시에 저장
      await redisSharding.writeThrough(cacheKey, sortedMessages, this.CACHE_TTL.RECENT_MESSAGES);

      console.log(`[MessageRepo] Recent messages loaded from DB: ${roomId}`);
      return sortedMessages;

    } catch (error) {
      console.error('[MessageRepo] Get recent messages error:', error);
      throw error;
    }
  }

  // 최근 메시지 캐시에 새 메시지 추가
  async addToRecentMessages(roomId, message, maxMessages = 50) {
    try {
      const cacheKey = `recent:${roomId}`;
      
      // 현재 최근 메시지들 가져오기
      let recentMessages = await redisSharding.readFromShard(cacheKey) || [];
      
      // 새 메시지 추가
      recentMessages.push(message);
      
      // 최대 개수 제한
      if (recentMessages.length > maxMessages) {
        recentMessages = recentMessages.slice(-maxMessages);
      }
      
      // 업데이트된 목록 저장
      await redisSharding.writeThrough(cacheKey, recentMessages, this.CACHE_TTL.RECENT_MESSAGES);
      
      console.log(`[MessageRepo] Added message to recent cache: ${roomId}`);

    } catch (error) {
      console.error('[MessageRepo] Add to recent messages error:', error);
    }
  }

  // 메시지 개수 조회/캐싱
  async getMessageCount(roomId) {
    try {
      const cacheKey = `msg_count:${roomId}`;
      
      // 캐시에서 먼저 조회
      let count = await redisSharding.readFromShard(cacheKey);
      
      if (count !== null && count !== undefined) {
        console.log(`[MessageRepo] Message count cache hit: ${roomId}`);
        return parseInt(count);
      }

      // 캐시 미스 - DB에서 조회
      count = await Message.countDocuments({ room: roomId });
      
      // 캐시에 저장
      await redisSharding.writeThrough(cacheKey, count, this.CACHE_TTL.MESSAGE_COUNT);
      
      console.log(`[MessageRepo] Message count loaded from DB: ${roomId} = ${count}`);
      return count;

    } catch (error) {
      console.error('[MessageRepo] Get message count error:', error);
      return 0;
    }
  }

  // 메시지 개수 증가
  async incrementMessageCount(roomId) {
    try {
      const cacheKey = `msg_count:${roomId}`;
      
      // 현재 캐시된 개수 가져오기
      let currentCount = await redisSharding.readFromShard(cacheKey);
      
      if (currentCount !== null && currentCount !== undefined) {
        // 캐시가 있으면 증가
        const newCount = parseInt(currentCount) + 1;
        await redisSharding.writeThrough(cacheKey, newCount, this.CACHE_TTL.MESSAGE_COUNT);
        console.log(`[MessageRepo] Message count incremented in cache: ${roomId} = ${newCount}`);
      } else {
        // 캐시가 없으면 DB에서 다시 계산
        const actualCount = await Message.countDocuments({ room: roomId });
        await redisSharding.writeThrough(cacheKey, actualCount, this.CACHE_TTL.MESSAGE_COUNT);
        console.log(`[MessageRepo] Message count recalculated: ${roomId} = ${actualCount}`);
      }

    } catch (error) {
      console.error('[MessageRepo] Increment message count error:', error);
    }
  }

  // 읽음 상태 업데이트
  async markMessagesAsRead(messageIds, userId) {
    try {
      // MongoDB 업데이트
      const result = await Message.updateMany(
        {
          _id: { $in: messageIds },
          'readers.userId': { $ne: userId }
        },
        {
          $push: {
            readers: {
              userId: userId,
              readAt: new Date()
            }
          }
        }
      );

      // 관련 캐시 무효화 (읽음 상태가 변경된 메시지들)
      const invalidationPromises = messageIds.map(messageId => {
        const cacheKey = `message:${messageId}`;
        return redisSharding.delete(cacheKey);
      });

      await Promise.all(invalidationPromises);

      console.log(`[MessageRepo] Marked ${result.modifiedCount} messages as read for user ${userId}`);
      return result;

    } catch (error) {
      console.error('[MessageRepo] Mark messages as read error:', error);
      throw error;
    }
  }

  // 메시지 리액션 업데이트
  async updateMessageReaction(messageId, reaction, userId, type) {
    try {
      const message = await Message.findById(messageId);
      if (!message) {
        throw new Error('메시지를 찾을 수 없습니다.');
      }

      // 리액션 추가/제거
      if (type === 'add') {
        await message.addReaction(reaction, userId);
      } else if (type === 'remove') {
        await message.removeReaction(reaction, userId);
      }

      // 캐시 업데이트
      const cacheKey = `message:${messageId}`;
      await redisSharding.writeThrough(cacheKey, message.toObject(), this.CACHE_TTL.MESSAGES);

      // 관련 배치 캐시 무효화
      await this.invalidateMessageBatchesForRoom(message.room.toString());

      console.log(`[MessageRepo] Message reaction updated: ${messageId}`);
      return message;

    } catch (error) {
      console.error('[MessageRepo] Update message reaction error:', error);
      throw error;
    }
  }

  // 특정 메시지 조회
  async getMessageById(messageId) {
    try {
      const cacheKey = `message:${messageId}`;
      
      // 캐시에서 먼저 조회
      let message = await redisSharding.readFromShard(cacheKey);
      
      if (message) {
        console.log(`[MessageRepo] Message cache hit: ${messageId}`);
        return message;
      }

      // 캐시 미스 - DB에서 조회
      message = await Message.findById(messageId)
        .populate('sender', 'name email profileImage')
        .populate({
          path: 'file',
          select: 'filename originalname mimetype size'
        })
        .lean();

      if (message) {
        // 캐시에 저장
        await redisSharding.writeThrough(cacheKey, message, this.CACHE_TTL.MESSAGES);
        console.log(`[MessageRepo] Message loaded from DB and cached: ${messageId}`);
      }

      return message;

    } catch (error) {
      console.error('[MessageRepo] Get message by ID error:', error);
      throw error;
    }
  }

  // 메시지 배치 캐시 무효화
  async invalidateMessageBatch(roomId, page) {
    try {
      const cacheKey = `messages:${roomId}:${page}`;
      await redisSharding.delete(cacheKey);
      console.log(`[MessageRepo] Invalidated message batch: ${cacheKey}`);
    } catch (error) {
      console.error('[MessageRepo] Invalidate message batch error:', error);
    }
  }

  // 방의 모든 메시지 배치 캐시 무효화
  async invalidateMessageBatchesForRoom(roomId, maxPages = 10) {
    try {
      const keys = [];
      for (let page = 0; page < maxPages; page++) {
        keys.push(`messages:${roomId}:${page}`);
      }
      
      await redisSharding.delete(keys);
      console.log(`[MessageRepo] Invalidated ${keys.length} message batches for room: ${roomId}`);
    } catch (error) {
      console.error('[MessageRepo] Invalidate message batches error:', error);
    }
  }

  // 방 관련 모든 캐시 무효화
  async invalidateRoomCache(roomId) {
    try {
      const patterns = [
        `messages:${roomId}:*`,
        `recent:${roomId}`,
        `msg_count:${roomId}`,
        `message:*` // 해당 방의 개별 메시지들 (패턴 매칭이 필요)
      ];

      for (const pattern of patterns) {
        await redisSharding.deletePattern(pattern);
      }

      console.log(`[MessageRepo] Invalidated all cache for room: ${roomId}`);
    } catch (error) {
      console.error('[MessageRepo] Invalidate room cache error:', error);
    }
  }

  // 캐시 유효성 검사
  isValidCacheForBefore(cached, before) {
    if (!before || !cached.oldestTimestamp) {
      return true;
    }
    
    const beforeDate = new Date(before);
    const oldestDate = new Date(cached.oldestTimestamp);
    
    return oldestDate <= beforeDate;
  }

  // 배치 메시지 조회 (여러 방의 최근 메시지들)
  async getBatchRecentMessages(roomIds, limit = 20) {
    try {
      const cacheKeys = roomIds.map(roomId => `recent:${roomId}`);
      const cachedResults = await redisSharding.mget(cacheKeys);
      
      const results = {};
      const missedRoomIds = [];

      // 캐시 히트/미스 분류
      cachedResults.forEach(({ key, value }, index) => {
        const roomId = roomIds[index];
        if (value && Array.isArray(value)) {
          results[roomId] = value.slice(-limit);
        } else {
          missedRoomIds.push(roomId);
        }
      });

      // 캐시 미스된 방들은 DB에서 조회
      if (missedRoomIds.length > 0) {
        const dbPromises = missedRoomIds.map(async (roomId) => {
          const messages = await Message.find({ room: roomId })
            .populate('sender', 'name email profileImage')
            .sort({ timestamp: -1 })
            .limit(limit)
            .lean();

          const sortedMessages = messages.reverse();
          
          // 캐시에 저장
          const cacheKey = `recent:${roomId}`;
          await redisSharding.writeThrough(cacheKey, sortedMessages, this.CACHE_TTL.RECENT_MESSAGES);
          
          return { roomId, messages: sortedMessages };
        });

        const dbResults = await Promise.all(dbPromises);
        dbResults.forEach(({ roomId, messages }) => {
          results[roomId] = messages;
        });
      }

      console.log(`[MessageRepo] Batch recent messages - Cache hits: ${roomIds.length - missedRoomIds.length}, DB queries: ${missedRoomIds.length}`);
      return results;

    } catch (error) {
      console.error('[MessageRepo] Get batch recent messages error:', error);
      throw error;
    }
  }

  // 통계 정보 조회
  async getStats() {
    try {
      const redisStats = await redisSharding.getStats();
      const mongoStats = await Message.collection.stats();
      
      return {
        redis: redisStats,
        mongodb: {
          documents: mongoStats.count,
          dataSize: mongoStats.size,
          indexSize: mongoStats.totalIndexSize,
          avgObjSize: mongoStats.avgObjSize
        },
        timestamp: Date.now()
      };
    } catch (error) {
      console.error('[MessageRepo] Get stats error:', error);
      return { error: error.message };
    }
  }
}

module.exports = new MessageRepository();