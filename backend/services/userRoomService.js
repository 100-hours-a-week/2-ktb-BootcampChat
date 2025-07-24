// backend/services/userRoomsService.js
const redisClient = require('../utils/redisClient');

class UserRoomsService {
  constructor() {
    this.USER_ROOMS_KEY = 'user_rooms';
    this.ROOM_PARTICIPANTS_KEY = 'room_participants';
    this.USER_ROOM_TTL = 24 * 60 * 60; // 24 hours
    this.ROOM_UPDATE_CHANNEL = 'room_updates';
    this.instanceId = process.env.INSTANCE_ID || `instance_${Date.now()}`;
  }

  // 사용자가 방에 입장
  async joinRoom(userId, roomId, userInfo = {}) {
    try {
      // 기존 방에서 나가기
      const previousRoom = await this.getUserRoom(userId);
      if (previousRoom && previousRoom !== roomId) {
        await this.leaveRoom(userId, previousRoom);
      }

      // 새 방 정보 저장
      const roomData = {
        userId,
        roomId,
        instanceId: this.instanceId,
        joinedAt: Date.now(),
        lastActivity: Date.now(),
        userInfo: {
          name: userInfo.name || '',
          socketId: userInfo.socketId || '',
          ...userInfo
        }
      };

      await redisClient.hset(
        this.USER_ROOMS_KEY,
        userId,
        JSON.stringify(roomData)
      );

      // 방 참가자 목록에 추가
      await this.addRoomParticipant(roomId, userId, roomData);

      // TTL 설정
      await redisClient.expire(this.USER_ROOMS_KEY, this.USER_ROOM_TTL);

      // 방 업데이트 알림
      await this.notifyRoomUpdate(roomId, {
        type: 'user_joined',
        userId,
        userInfo: roomData.userInfo,
        instanceId: this.instanceId,
        timestamp: Date.now()
      });

      console.log(`👥 User ${userId} joined room ${roomId} on instance ${this.instanceId}`);
      return roomData;

    } catch (error) {
      console.error('❌ Join room error:', error);
      throw error;
    }
  }

  // 사용자가 방에서 나가기
  async leaveRoom(userId, roomId = null) {
    try {
      // roomId가 없으면 현재 방 조회
      if (!roomId) {
        roomId = await this.getUserRoom(userId);
        if (!roomId) {
          return false;
        }
      }

      // 사용자 방 정보 제거
      const removed = await redisClient.hdel(this.USER_ROOMS_KEY, userId);

      // 방 참가자 목록에서 제거
      await this.removeRoomParticipant(roomId, userId);

      // 방 업데이트 알림
      if (removed) {
        await this.notifyRoomUpdate(roomId, {
          type: 'user_left',
          userId,
          instanceId: this.instanceId,
          timestamp: Date.now()
        });

        console.log(`👋 User ${userId} left room ${roomId} on instance ${this.instanceId}`);
      }

      return removed > 0;
    } catch (error) {
      console.error('❌ Leave room error:', error);
      throw error;
    }
  }

  // 사용자의 현재 방 조회
  async getUserRoom(userId) {
    try {
      const roomDataStr = await redisClient.hget(this.USER_ROOMS_KEY, userId);
      
      if (!roomDataStr) {
        return null;
      }

      const roomData = JSON.parse(roomDataStr);
      return roomData.roomId;
    } catch (error) {
      console.error('❌ Get user room error:', error);
      return null;
    }
  }

  // 사용자의 방 상세 정보 조회
  async getUserRoomData(userId) {
    try {
      const roomDataStr = await redisClient.hget(this.USER_ROOMS_KEY, userId);
      
      if (!roomDataStr) {
        return null;
      }

      return JSON.parse(roomDataStr);
    } catch (error) {
      console.error('❌ Get user room data error:', error);
      return null;
    }
  }

  // 방 참가자 목록에 추가
  async addRoomParticipant(roomId, userId, userData) {
    try {
      const participantKey = `${this.ROOM_PARTICIPANTS_KEY}:${roomId}`;
      
      await redisClient.hset(
        participantKey,
        userId,
        JSON.stringify({
          userId,
          instanceId: userData.instanceId,
          joinedAt: userData.joinedAt,
          lastActivity: userData.lastActivity,
          userInfo: userData.userInfo
        })
      );

      await redisClient.expire(participantKey, this.USER_ROOM_TTL);
      return true;
    } catch (error) {
      console.error('❌ Add room participant error:', error);
      return false;
    }
  }

  // 방 참가자 목록에서 제거
  async removeRoomParticipant(roomId, userId) {
    try {
      const participantKey = `${this.ROOM_PARTICIPANTS_KEY}:${roomId}`;
      const removed = await redisClient.hdel(participantKey, userId);
      
      return removed > 0;
    } catch (error) {
      console.error('❌ Remove room participant error:', error);
      return false;
    }
  }

  // 방의 모든 참가자 조회
  async getRoomParticipants(roomId) {
    try {
      const participantKey = `${this.ROOM_PARTICIPANTS_KEY}:${roomId}`;
      const participantsData = await redisClient.hgetall(participantKey);
      
      const participants = {};
      for (const [userId, dataStr] of Object.entries(participantsData)) {
        try {
          participants[userId] = JSON.parse(dataStr);
        } catch (parseError) {
          console.error(`❌ Failed to parse participant data for ${userId}:`, parseError);
        }
      }

      return participants;
    } catch (error) {
      console.error('❌ Get room participants error:', error);
      return {};
    }
  }

  // 방의 참가자 수 조회
  async getRoomParticipantCount(roomId) {
    try {
      const participants = await this.getRoomParticipants(roomId);
      return Object.keys(participants).length;
    } catch (error) {
      console.error('❌ Get room participant count error:', error);
      return 0;
    }
  }

  // 특정 인스턴스의 방 참가자들 조회
  async getRoomParticipantsByInstance(roomId, instanceId) {
    try {
      const allParticipants = await this.getRoomParticipants(roomId);
      
      return Object.values(allParticipants).filter(
        participant => participant.instanceId === instanceId
      );
    } catch (error) {
      console.error('❌ Get room participants by instance error:', error);
      return [];
    }
  }

  // 사용자 활동 시간 업데이트
  async updateUserActivity(userId) {
    try {
      const roomData = await this.getUserRoomData(userId);
      
      if (!roomData) {
        return false;
      }

      roomData.lastActivity = Date.now();

      // 사용자 방 정보 업데이트
      await redisClient.hset(
        this.USER_ROOMS_KEY,
        userId,
        JSON.stringify(roomData)
      );

      // 방 참가자 목록도 업데이트
      const participantKey = `${this.ROOM_PARTICIPANTS_KEY}:${roomData.roomId}`;
      const participantData = await redisClient.hget(participantKey, userId);
      
      if (participantData) {
        const parsed = JSON.parse(participantData);
        parsed.lastActivity = Date.now();
        
        await redisClient.hset(
          participantKey,
          userId,
          JSON.stringify(parsed)
        );
      }

      return true;
    } catch (error) {
      console.error('❌ Update user activity error:', error);
      return false;
    }
  }

  // 방 업데이트 알림 발송
  async notifyRoomUpdate(roomId, updateData) {
    try {
      const notification = {
        roomId,
        ...updateData
      };

      await redisClient.publish(
        this.ROOM_UPDATE_CHANNEL,
        JSON.stringify(notification)
      );

      console.log(`📢 Room update notification sent for room ${roomId}`);
    } catch (error) {
      console.error('❌ Notify room update error:', error);
    }
  }

  // 방 업데이트 이벤트 구독
  async subscribeRoomUpdates(callback) {
    try {
      const subscriber = await redisClient.createSubscriber();
      
      subscriber.on('message', (channel, message) => {
        if (channel === this.ROOM_UPDATE_CHANNEL) {
          try {
            const notification = JSON.parse(message);
            callback(notification);
          } catch (parseError) {
            console.error('❌ Failed to parse room update notification:', parseError);
          }
        }
      });

      await subscriber.subscribe(this.ROOM_UPDATE_CHANNEL);
      console.log('📡 Subscribed to room update notifications');
      return subscriber;
    } catch (error) {
      console.error('❌ Subscribe room updates error:', error);
      throw error;
    }
  }

  // 모든 사용자-방 매핑 조회
  async getAllUserRooms() {
    try {
      const allUserRooms = await redisClient.hgetall(this.USER_ROOMS_KEY);
      
      const parsedData = {};
      for (const [userId, roomDataStr] of Object.entries(allUserRooms)) {
        try {
          parsedData[userId] = JSON.parse(roomDataStr);
        } catch (parseError) {
          console.error(`❌ Failed to parse room data for user ${userId}:`, parseError);
        }
      }

      return parsedData;
    } catch (error) {
      console.error('❌ Get all user rooms error:', error);
      return {};
    }
  }

  // 특정 방에 속한 사용자들 조회
  async getUsersInRoom(roomId) {
    try {
      const allUserRooms = await this.getAllUserRooms();
      
      return Object.entries(allUserRooms)
        .filter(([userId, roomData]) => roomData.roomId === roomId)
        .map(([userId, roomData]) => ({
          userId,
          ...roomData
        }));
    } catch (error) {
      console.error('❌ Get users in room error:', error);
      return [];
    }
  }

  // 비활성 사용자 정리
  async cleanupInactiveUsers(maxInactiveTime = 30 * 60 * 1000) { // 30분
    try {
      const allUserRooms = await this.getAllUserRooms();
      const currentTime = Date.now();
      let cleanedCount = 0;

      for (const [userId, roomData] of Object.entries(allUserRooms)) {
        if (currentTime - roomData.lastActivity > maxInactiveTime) {
          await this.leaveRoom(userId, roomData.roomId);
          cleanedCount++;
        }
      }

      // 빈 방 참가자 목록들도 정리
      const roomKeys = await this.getActiveRoomKeys();
      for (const roomKey of roomKeys) {
        const participants = await redisClient.hgetall(roomKey);
        let roomCleanedCount = 0;

        for (const [userId, participantDataStr] of Object.entries(participants)) {
          try {
            const participantData = JSON.parse(participantDataStr);
            if (currentTime - participantData.lastActivity > maxInactiveTime) {
              await redisClient.hdel(roomKey, userId);
              roomCleanedCount++;
            }
          } catch (parseError) {
            // 파싱 실패한 데이터는 제거
            await redisClient.hdel(roomKey, userId);
            roomCleanedCount++;
          }
        }

        if (roomCleanedCount > 0) {
          cleanedCount += roomCleanedCount;
        }

        // 빈 방이면 키 자체를 삭제
        const remainingParticipants = await redisClient.hlen(roomKey);
        if (remainingParticipants === 0) {
          await redisClient.del(roomKey);
          console.log(`🗑️ Deleted empty room key: ${roomKey}`);
        }
      }

      if (cleanedCount > 0) {
        console.log(`🧹 Cleaned up ${cleanedCount} inactive room participants`);
      }

      return cleanedCount;
    } catch (error) {
      console.error('❌ Cleanup inactive users error:', error);
      return 0;
    }
  }

  // 활성 방 키들 조회
  async getActiveRoomKeys() {
    try {
      // Redis KEYS 명령은 성능상 좋지 않지만, 정리 작업에서만 사용
      const keys = await redisClient.keys(`${this.ROOM_PARTICIPANTS_KEY}:*`);
      return keys;
    } catch (error) {
      console.error('❌ Get active room keys error:', error);
      return [];
    }
  }

  // 서비스 상태 확인
  async getStatus() {
    try {
      const allUserRooms = await this.getAllUserRooms();
      const userCount = Object.keys(allUserRooms).length;

      // 인스턴스별 통계
      const instanceStats = {};
      const roomStats = {};

      Object.values(allUserRooms).forEach(roomData => {
        const instance = roomData.instanceId || 'unknown';
        const room = roomData.roomId;

        instanceStats[instance] = (instanceStats[instance] || 0) + 1;
        roomStats[room] = (roomStats[room] || 0) + 1;
      });

      // 활성 방 수
      const activeRoomKeys = await this.getActiveRoomKeys();
      const activeRoomCount = activeRoomKeys.length;

      return {
        instanceId: this.instanceId,
        totalUsersInRooms: userCount,
        activeRooms: activeRoomCount,
        instanceStats,
        topRooms: Object.entries(roomStats)
          .sort(([,a], [,b]) => b - a)
          .slice(0, 10)
          .reduce((obj, [room, count]) => {
            obj[room] = count;
            return obj;
          }, {}),
        redisConnected: redisClient.getStatus().connected
      };
    } catch (error) {
      console.error('❌ Get status error:', error);
      return {
        instanceId: this.instanceId,
        totalUsersInRooms: 0,
        activeRooms: 0,
        instanceStats: {},
        topRooms: {},
        redisConnected: false,
        error: error.message
      };
    }
  }

  // 방 통계 조회
  async getRoomStats(roomId) {
    try {
      const participants = await this.getRoomParticipants(roomId);
      const participantCount = Object.keys(participants).length;

      // 인스턴스별 분포
      const instanceDistribution = {};
      Object.values(participants).forEach(participant => {
        const instance = participant.instanceId || 'unknown';
        instanceDistribution[instance] = (instanceDistribution[instance] || 0) + 1;
      });

      // 최근 활동 시간 계산
      const activities = Object.values(participants).map(p => p.lastActivity || 0);
      const lastActivity = activities.length > 0 ? Math.max(...activities) : 0;

      return {
        roomId,
        participantCount,
        instanceDistribution,
        lastActivity,
        participants: Object.keys(participants)
      };
    } catch (error) {
      console.error('❌ Get room stats error:', error);
      return {
        roomId,
        participantCount: 0,
        instanceDistribution: {},
        lastActivity: 0,
        participants: [],
        error: error.message
      };
    }
  }
}

module.exports = new UserRoomsService();