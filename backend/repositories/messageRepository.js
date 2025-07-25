const Message = require('../models/Message');
const redisSharding = require('../utils/redisCluster');

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
    const message = new Message(messageData);
    await message.save();
    await message.populate([
      { path: 'sender', select: 'name email profileImage' },
      { path: 'file', select: 'filename originalname mimetype size' }
    ]);

    const cacheKey = `message:${message._id}`;
    await redisSharding.set(cacheKey, message.toObject(), this.CACHE_TTL.MESSAGES);

    await this.addToRecentMessages(message.room.toString(), message.toObject());
    await this.incrementMessageCount(message.room.toString());
    await this.invalidateMessageBatch(message.room.toString(), 0);

    return message;
  }

  // 메시지 배치 조회 (캐시 우선)
  async getMessagesBatch(roomId, page = 0, limit = 30, before = null) {
    const cacheKey = `messages:${roomId}:${page}`;
    let cached = await redisSharding.get(cacheKey);

    if (cached && (!before || this.isValidCacheForBefore(cached, before))) {
      return cached;
    }

    const query = { room: roomId };
    if (before) query.timestamp = { $lt: new Date(before) };

    const messages = await Message.find(query)
      .populate('sender', 'name email profileImage')
      .populate({ path: 'file', select: 'filename originalname mimetype size' })
      .sort({ timestamp: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = messages.length > limit;
    const resultMessages = messages.slice(0, limit).sort((a, b) => a.timestamp - b.timestamp);
    const result = { messages: resultMessages, hasMore, oldestTimestamp: resultMessages[0]?.timestamp || null, cachedAt: Date.now() };

    await redisSharding.set(cacheKey, result, this.CACHE_TTL.MESSAGE_BATCH);
    return result;
  }

  // 최근 메시지 조회
  async getRecentMessages(roomId, limit = 20) {
    const cacheKey = `recent:${roomId}`;
    let recent = await redisSharding.get(cacheKey);

    if (Array.isArray(recent) && recent.length) {
      return recent.slice(-limit);
    }

    const messages = await Message.find({ room: roomId })
      .populate('sender', 'name email profileImage')
      .populate({ path: 'file', select: 'filename originalname mimetype size' })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    const sorted = messages.reverse();
    await redisSharding.set(cacheKey, sorted, this.CACHE_TTL.RECENT_MESSAGES);
    return sorted;
  }

  async addToRecentMessages(roomId, message, max = 50) {
    const cacheKey = `recent:${roomId}`;
    let arr = await redisSharding.get(cacheKey) || [];
    arr.push(message);
    if (arr.length > max) arr = arr.slice(-max);
    await redisSharding.set(cacheKey, arr, this.CACHE_TTL.RECENT_MESSAGES);
  }

  async getMessageCount(roomId) {
    const cacheKey = `msg_count:${roomId}`;
    let count = await redisSharding.get(cacheKey);
    if (count != null) return parseInt(count, 10);

    count = await Message.countDocuments({ room: roomId });
    await redisSharding.set(cacheKey, count, this.CACHE_TTL.MESSAGE_COUNT);
    return count;
  }

  async incrementMessageCount(roomId) {
    const cacheKey = `msg_count:${roomId}`;
    let count = await redisSharding.get(cacheKey);
    if (count != null) {
      await redisSharding.set(cacheKey, parseInt(count, 10) + 1, this.CACHE_TTL.MESSAGE_COUNT);
    } else {
      const c = await Message.countDocuments({ room: roomId });
      await redisSharding.set(cacheKey, c, this.CACHE_TTL.MESSAGE_COUNT);
    }
  }

  async markMessagesAsRead(ids, userId) {
    const res = await Message.updateMany(
      { _id: { $in: ids }, 'readers.userId': { $ne: userId } },
      { $push: { readers: { userId, readAt: new Date() } } }
    );
    await Promise.all(ids.map(id => redisSharding.del(`message:${id}`)));
    return res;
  }

  async updateMessageReaction(id, reaction, userId, type) {
    const msg = await Message.findById(id);
    if (!msg) throw new Error('Message not found');
    if (type === 'add') await msg.addReaction(reaction, userId);
    else await msg.removeReaction(reaction, userId);
    await redisSharding.set(`message:${id}`, msg.toObject(), this.CACHE_TTL.MESSAGES);
    await this.invalidateMessageBatchesForRoom(msg.room.toString());
    return msg;
  }

  async getMessageById(id) {
    const key = `message:${id}`;
    let msg = await redisSharding.get(key);
    if (msg) return msg;
    msg = await Message.findById(id)
      .populate('sender', 'name email profileImage')
      .populate({ path: 'file', select: 'filename originalname mimetype size' })
      .lean();
    if (msg) await redisSharding.set(key, msg, this.CACHE_TTL.MESSAGES);
    return msg;
  }

  async invalidateMessageBatch(roomId, page) {
    await redisSharding.del(`messages:${roomId}:${page}`);
  }

  async invalidateMessageBatchesForRoom(roomId, max = 10) {
    const keys = Array.from({ length: max }, (_, i) => `messages:${roomId}:${i}`);
    await redisSharding.del(...keys);
  }

  async invalidateRoomCache(roomId) {
    const patterns = [`messages:${roomId}:*`, `recent:${roomId}`, `msg_count:${roomId}`, `message:*`];
    for (const p of patterns) await redisSharding.deletePattern(p);
  }

  isValidCacheForBefore(cached, before) {
    if (!before || !cached.oldestTimestamp) return true;
    return new Date(cached.oldestTimestamp) <= new Date(before);
  }

  // 병렬 get 호출로 대체
  async getBatchRecentMessages(roomIds, limit = 20) {
    const results = {};
    const missed = [];
    const promises = roomIds.map(async id => {
      const key = `recent:${id}`;
      const val = await redisSharding.get(key);
      if (Array.isArray(val)) {
        results[id] = val.slice(-limit);
      } else {
        missed.push(id);
      }
    });
    await Promise.all(promises);

    if (missed.length) {
      const dbPromises = missed.map(async id => {
        const msgs = await Message.find({ room: id })
          .populate('sender', 'name email profileImage')
          .sort({ timestamp: -1 })
          .limit(limit)
          .lean();
        const sorted = msgs.reverse();
        results[id] = sorted;
        await redisSharding.set(`recent:${id}`, sorted, this.CACHE_TTL.RECENT_MESSAGES);
      });
      await Promise.all(dbPromises);
    }

    return results;
  }

  async getStats() {
    const redisStats = await redisSharding.getStats();
    const mongoStats = await Message.collection.stats();
    return { redis: redisStats, mongodb: {
      documents: mongoStats.count,
      dataSize: mongoStats.size,
      indexSize: mongoStats.totalIndexSize,
      avgObjSize: mongoStats.avgObjSize
    }, timestamp: Date.now() };
  }
}

module.exports = new MessageRepository();