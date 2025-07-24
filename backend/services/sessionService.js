// backend/services/sessionService.js
const redisClient = require('../utils/redisClient');
const crypto = require('crypto');
const connectedUsersService = require('./connectedUsersService');

class SessionService {
  static SESSION_TTL = 24 * 60 * 60; // 24 hours
  static SESSION_PREFIX = 'session:';
  static SESSION_ID_PREFIX = 'sessionId:';
  static USER_SESSIONS_PREFIX = 'user_sessions:';
  static ACTIVE_SESSION_PREFIX = 'active_session:';
  static GLOBAL_SESSIONS_PREFIX = 'global_sessions:'; // 글로벌 세션 추적용

  // 안전한 JSON 직렬화
  static safeStringify(data) {
    try {
      if (typeof data === 'string') return data;
      return JSON.stringify(data);
    } catch (error) {
      console.error('JSON stringify error:', error);
      return '';
    }
  }

  // 안전한 JSON 파싱
  static safeParse(data) {
    try {
      if (!data) return null;
      if (typeof data === 'object') return data;
      if (typeof data !== 'string') return null;
      
      if (data === '[object Object]') return null;
      
      return JSON.parse(data);
    } catch (error) {
      console.error('JSON parse error:', error);
      return null;
    }
  }

  // Redis에 데이터 저장 전 JSON 문자열로 변환
  static async setJson(key, value, ttl) {
    try {
      const jsonString = this.safeStringify(value);
      if (!jsonString) {
        console.error('Failed to stringify value:', value);
        return false;
      }

      if (ttl) {
        await redisClient.setEx(key, ttl, jsonString);
      } else {
        await redisClient.set(key, jsonString);
      }
      return true;
    } catch (error) {
      console.error('Redis setJson error:', error);
      return false;
    }
  }

  // Redis에서 데이터를 가져와서 JSON으로 파싱
  static async getJson(key) {
    try {
      const value = await redisClient.get(key);
      return this.safeParse(value);
    } catch (error) {
      console.error('Redis getJson error:', error);
      return null;
    }
  }

  static async createSession(userId, metadata = {}) {
    try {
      const instanceId = process.env.INSTANCE_ID || `instance_${Date.now()}`;
      
      // 글로벌 세션 충돌 확인
      const existingGlobalSession = await this.getGlobalSession(userId);
      
      if (existingGlobalSession) {
        console.log(`🔍 Existing global session found for user ${userId}:`, {
          existingInstanceId: existingGlobalSession.instanceId,
          currentInstanceId: instanceId,
          existingSessionId: existingGlobalSession.sessionId
        });

        // 다른 인스턴스에서 활성 세션이 있는 경우
        if (existingGlobalSession.instanceId !== instanceId) {
          console.log(`⚠️ Cross-instance session conflict detected for user ${userId}`);
          
          // 기존 세션 무효화 알림
          await this.notifySessionConflict(userId, existingGlobalSession, {
            instanceId,
            userAgent: metadata.userAgent,
            ipAddress: metadata.ipAddress
          });
        }
        
        // 기존 세션들 모두 제거
        await this.removeAllUserSessions(userId);
      }

      const sessionId = this.generateSessionId();
      const sessionData = {
        userId,
        sessionId,
        instanceId,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        metadata: {
          userAgent: metadata.userAgent || '',
          ipAddress: metadata.ipAddress || '',
          deviceInfo: metadata.deviceInfo || '',
          ...metadata
        }
      };

      const sessionKey = this.getSessionKey(userId);
      const sessionIdKey = this.getSessionIdKey(sessionId);
      const userSessionsKey = this.getUserSessionsKey(userId);
      const activeSessionKey = this.getActiveSessionKey(userId);
      const globalSessionKey = this.getGlobalSessionKey(userId);

      // 세션 데이터 저장
      const saved = await this.setJson(sessionKey, sessionData, this.SESSION_TTL);
      if (!saved) {
        throw new Error('세션 데이터 저장에 실패했습니다.');
      }

      // 다양한 키 매핑 저장
      await redisClient.setEx(sessionIdKey, this.SESSION_TTL, userId.toString());
      await redisClient.setEx(userSessionsKey, this.SESSION_TTL, sessionId);
      await redisClient.setEx(activeSessionKey, this.SESSION_TTL, sessionId);

      // 글로벌 세션 정보 저장
      await this.setJson(globalSessionKey, sessionData, this.SESSION_TTL);

      console.log(`✅ Session created for user ${userId} on instance ${instanceId}`);

      return {
        sessionId,
        expiresIn: this.SESSION_TTL,
        sessionData
      };

    } catch (error) {
      console.error('❌ Session creation error:', error);
      throw new Error('세션 생성 중 오류가 발생했습니다.');
    }
  }

  static async validateSession(userId, sessionId) {
    try {
      if (!userId || !sessionId) {
        return {
          isValid: false,
          error: 'INVALID_PARAMETERS',
          message: '유효하지 않은 세션 파라미터'
        };
      }

      // 글로벌 세션 확인
      const globalSession = await this.getGlobalSession(userId);
      if (!globalSession) {
        return {
          isValid: false,
          error: 'SESSION_NOT_FOUND',
          message: '세션을 찾을 수 없습니다.'
        };
      }

      // 세션 ID 일치 확인
      if (globalSession.sessionId !== sessionId) {
        console.log(`❌ Session ID mismatch for user ${userId}:`, {
          provided: sessionId,
          expected: globalSession.sessionId
        });
        return {
          isValid: false,
          error: 'INVALID_SESSION',
          message: '다른 기기에서 로그인되어 현재 세션이 만료되었습니다.'
        };
      }

      // 인스턴스 확인
      const currentInstanceId = process.env.INSTANCE_ID || `instance_${Date.now()}`;
      if (globalSession.instanceId !== currentInstanceId) {
        console.log(`⚠️ Session belongs to different instance for user ${userId}:`, {
          sessionInstance: globalSession.instanceId,
          currentInstance: currentInstanceId
        });
        
        return {
          isValid: false,
          error: 'SESSION_INSTANCE_MISMATCH',
          message: '다른 인스턴스에서 활성화된 세션입니다.'
        };
      }

      // 활성 세션 확인
      const activeSessionKey = this.getActiveSessionKey(userId);
      const activeSessionId = await redisClient.get(activeSessionKey);

      if (!activeSessionId || activeSessionId !== sessionId) {
        return {
          isValid: false,
          error: 'INVALID_SESSION',
          message: '활성 세션이 아닙니다.'
        };
      }

      // 세션 데이터 검증
      const sessionKey = this.getSessionKey(userId);
      const sessionData = await this.getJson(sessionKey);

      if (!sessionData) {
        return {
          isValid: false,
          error: 'SESSION_DATA_NOT_FOUND',
          message: '세션 데이터를 찾을 수 없습니다.'
        };
      }

      // 세션 만료 시간 검증
      const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24시간
      if (Date.now() - sessionData.lastActivity > SESSION_TIMEOUT) {
        await this.removeSession(userId);
        return {
          isValid: false,
          error: 'SESSION_EXPIRED',
          message: '세션이 만료되었습니다.'
        };
      }

      // 세션 데이터 갱신
      sessionData.lastActivity = Date.now();
      
      // 갱신된 세션 데이터 저장
      const updated = await this.setJson(sessionKey, sessionData, this.SESSION_TTL);
      if (!updated) {
        return {
          isValid: false,
          error: 'UPDATE_FAILED',
          message: '세션 갱신에 실패했습니다.'
        };
      }

      // 글로벌 세션도 갱신
      const globalSessionKey = this.getGlobalSessionKey(userId);
      await this.setJson(globalSessionKey, sessionData, this.SESSION_TTL);

      // 관련 키들의 만료 시간 갱신
      await Promise.all([
        redisClient.expire(activeSessionKey, this.SESSION_TTL),
        redisClient.expire(this.getUserSessionsKey(userId), this.SESSION_TTL),
        redisClient.expire(this.getSessionIdKey(sessionId), this.SESSION_TTL)
      ]);

      return {
        isValid: true,
        session: sessionData
      };

    } catch (error) {
      console.error('❌ Session validation error:', error);
      return {
        isValid: false,
        error: 'VALIDATION_ERROR',
        message: '세션 검증 중 오류가 발생했습니다.'
      };
    }
  }

  // 글로벌 세션 조회
  static async getGlobalSession(userId) {
    try {
      const globalSessionKey = this.getGlobalSessionKey(userId);
      return await this.getJson(globalSessionKey);
    } catch (error) {
      console.error('❌ Get global session error:', error);
      return null;
    }
  }

  // 세션 충돌 알림
  static async notifySessionConflict(userId, existingSession, newSessionInfo) {
    try {
      await connectedUsersService.notifyDuplicateLogin(
        userId,
        existingSession,
        newSessionInfo
      );
    } catch (error) {
      console.error('❌ Notify session conflict error:', error);
    }
  }

  static async removeSession(userId, sessionId = null) {
    try {
      const userSessionsKey = this.getUserSessionsKey(userId);
      const activeSessionKey = this.getActiveSessionKey(userId);
      const globalSessionKey = this.getGlobalSessionKey(userId);

      if (sessionId) {
        const currentSessionId = await redisClient.get(userSessionsKey);
        if (currentSessionId === sessionId) {
          await Promise.all([
            redisClient.del(this.getSessionKey(userId)),
            redisClient.del(this.getSessionIdKey(sessionId)),
            redisClient.del(userSessionsKey),
            redisClient.del(activeSessionKey),
            redisClient.del(globalSessionKey)
          ]);
        }
      } else {
        const storedSessionId = await redisClient.get(userSessionsKey);
        if (storedSessionId) {
          await Promise.all([
            redisClient.del(this.getSessionKey(userId)),
            redisClient.del(this.getSessionIdKey(storedSessionId)),
            redisClient.del(userSessionsKey),
            redisClient.del(activeSessionKey),
            redisClient.del(globalSessionKey)
          ]);
        }
      }

      console.log(`🗑️ Session removed for user ${userId}`);
    } catch (error) {
      console.error('❌ Session removal error:', error);
      throw error;
    }
  }

  static async removeAllUserSessions(userId) {
    try {
      const activeSessionKey = this.getActiveSessionKey(userId);
      const userSessionsKey = this.getUserSessionsKey(userId);
      const globalSessionKey = this.getGlobalSessionKey(userId);
      const sessionId = await redisClient.get(userSessionsKey);

      const deletePromises = [
        redisClient.del(activeSessionKey),
        redisClient.del(userSessionsKey),
        redisClient.del(globalSessionKey)
      ];

      if (sessionId) {
        deletePromises.push(
          redisClient.del(this.getSessionKey(userId)),
          redisClient.del(this.getSessionIdKey(sessionId))
        );
      }

      await Promise.all(deletePromises);
      
      console.log(`🧹 All sessions removed for user ${userId}`);
      return true;
    } catch (error) {
      console.error('❌ Remove all user sessions error:', error);
      return false;
    }
  }

  static async updateLastActivity(userId) {
    try {
      if (!userId) {
        console.error('updateLastActivity: userId is required');
        return false;
      }

      const sessionKey = this.getSessionKey(userId);
      const sessionData = await this.getJson(sessionKey);

      if (!sessionData) {
        console.error('updateLastActivity: No session found for user', userId);
        return false;
      }

      // 세션 데이터 갱신
      sessionData.lastActivity = Date.now();
      
      // 갱신된 세션 데이터 저장
      const updated = await this.setJson(sessionKey, sessionData, this.SESSION_TTL);
      if (!updated) {
        console.error('updateLastActivity: Failed to update session data');
        return false;
      }

      // 글로벌 세션도 갱신
      const globalSessionKey = this.getGlobalSessionKey(userId);
      await this.setJson(globalSessionKey, sessionData, this.SESSION_TTL);

      // 관련 키들의 만료 시간도 함께 갱신
      const activeSessionKey = this.getActiveSessionKey(userId);
      const userSessionsKey = this.getUserSessionsKey(userId);
      if (sessionData.sessionId) {
        const sessionIdKey = this.getSessionIdKey(sessionData.sessionId);
        await Promise.all([
          redisClient.expire(activeSessionKey, this.SESSION_TTL),
          redisClient.expire(userSessionsKey, this.SESSION_TTL),
          redisClient.expire(sessionIdKey, this.SESSION_TTL)
        ]);
      }

      return true;

    } catch (error) {
      console.error('❌ Update last activity error:', error);
      return false;
    }
  }  
  
  static async getActiveSession(userId) {
    try {
      if (!userId) {
        console.error('getActiveSession: userId is required');
        return null;
      }

      // 글로벌 세션부터 확인
      const globalSession = await this.getGlobalSession(userId);
      if (!globalSession) {
        return null;
      }

      // 현재 인스턴스의 세션인지 확인
      const currentInstanceId = process.env.INSTANCE_ID || `instance_${Date.now()}`;
      if (globalSession.instanceId !== currentInstanceId) {
        console.log(`ℹ️ Active session for user ${userId} is on different instance: ${globalSession.instanceId}`);
        return null;
      }

      const activeSessionKey = this.getActiveSessionKey(userId);
      const sessionId = await redisClient.get(activeSessionKey);

      if (!sessionId) {
        return null;
      }

      const sessionKey = this.getSessionKey(userId);
      const sessionData = await this.getJson(sessionKey);

      if (!sessionData) {
        await redisClient.del(activeSessionKey);
        return null;
      }

      return {
        ...sessionData,
        userId,
        sessionId
      };
    } catch (error) {
      console.error('❌ Get active session error:', error);
      return null;
    }
  }

  // 키 생성 메서드들
  static getSessionKey(userId) {
    return `${this.SESSION_PREFIX}${userId}`;
  }

  static getSessionIdKey(sessionId) {
    return `${this.SESSION_ID_PREFIX}${sessionId}`;
  }

  static getUserSessionsKey(userId) {
    return `${this.USER_SESSIONS_PREFIX}${userId}`;
  }

  static getActiveSessionKey(userId) {
    return `${this.ACTIVE_SESSION_PREFIX}${userId}`;
  }

  static getGlobalSessionKey(userId) {
    return `${this.GLOBAL_SESSIONS_PREFIX}${userId}`;
  }

  static generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
  }

  // 세션 통계 조회
  static async getSessionStats() {
    try {
      const allGlobalSessions = await this.getAllGlobalSessions();
      const currentInstanceId = process.env.INSTANCE_ID || `instance_${Date.now()}`;

      // 인스턴스별 세션 분포
      const instanceStats = {};
      let currentInstanceSessions = 0;

      Object.values(allGlobalSessions).forEach(session => {
        const instance = session.instanceId || 'unknown';
        instanceStats[instance] = (instanceStats[instance] || 0) + 1;
        
        if (instance === currentInstanceId) {
          currentInstanceSessions++;
        }
      });

      return {
        totalGlobalSessions: Object.keys(allGlobalSessions).length,
        currentInstanceSessions,
        instanceStats,
        redisConnected: redisClient.getStatus().connected
      };
    } catch (error) {
      console.error('❌ Get session stats error:', error);
      return {
        totalGlobalSessions: 0,
        currentInstanceSessions: 0,
        instanceStats: {},
        redisConnected: false,
        error: error.message
      };
    }
  }

  // 모든 글로벌 세션 조회
  static async getAllGlobalSessions() {
    try {
      const keys = await redisClient.keys(`${this.GLOBAL_SESSIONS_PREFIX}*`);
      const sessions = {};

      for (const key of keys) {
        const userId = key.replace(this.GLOBAL_SESSIONS_PREFIX, '');
        const sessionData = await this.getJson(key);
        if (sessionData) {
          sessions[userId] = sessionData;
        }
      }

      return sessions;
    } catch (error) {
      console.error('❌ Get all global sessions error:', error);
      return {};
    }
  }
}

module.exports = SessionService;