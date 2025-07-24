const Message = require('../models/Message');
const Room = require('../models/Room');
const User = require('../models/User');
const File = require('../models/File');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/keys');
const redisClient = require('../utils/redisClient');
const SessionService = require('../services/sessionService');
const aiService = require('../services/aiService');
const userRoomsService = require('../services/userRoomsService');

module.exports = function(io) {
  // Redis 기반 데이터 저장을 위한 키 정의
  const CONNECTED_USERS_KEY = 'connected_users';
  const STREAMING_SESSIONS_KEY = 'streaming_sessions';
  const MESSAGE_QUEUES_KEY = 'message_queues';
  const MESSAGE_RETRIES_KEY = 'message_retries';

  // 기존 Map들을 Redis로 대체하기 위한 헬퍼 함수들
  const connectedUsers = {
    async set(userId, socketId) {
      await redisClient.hset(CONNECTED_USERS_KEY, userId, JSON.stringify({
        socketId,
        instanceId: process.env.INSTANCE_ID || 'default',
        connectedAt: Date.now(),
        lastActivity: Date.now()
      }));
    },
    
    async get(userId) {
      const data = await redisClient.hget(CONNECTED_USERS_KEY, userId);
      return data ? JSON.parse(data) : null;
    },
    
    async delete(userId) {
      return await redisClient.hdel(CONNECTED_USERS_KEY, userId);
    },
    
    async getAll() {
      return await redisClient.hgetall(CONNECTED_USERS_KEY);
    }
  };

  const streamingSessions = {
    async set(messageId, sessionData) {
      await redisClient.hset(STREAMING_SESSIONS_KEY, messageId, JSON.stringify(sessionData));
    },
    
    async get(messageId) {
      const data = await redisClient.hget(STREAMING_SESSIONS_KEY, messageId);
      return data ? JSON.parse(data) : null;
    },
    
    async delete(messageId) {
      return await redisClient.hdel(STREAMING_SESSIONS_KEY, messageId);
    },
    
    async values() {
      const allSessions = await redisClient.hgetall(STREAMING_SESSIONS_KEY);
      return Object.values(allSessions).map(data => JSON.parse(data));
    },
    
    async entries() {
      const allSessions = await redisClient.hgetall(STREAMING_SESSIONS_KEY);
      return Object.entries(allSessions).map(([key, value]) => [key, JSON.parse(value)]);
    }
  };

  const messageQueues = {
    async set(queueKey, value) {
      await redisClient.hset(MESSAGE_QUEUES_KEY, queueKey, value);
    },
    
    async get(queueKey) {
      return await redisClient.hget(MESSAGE_QUEUES_KEY, queueKey);
    },
    
    async delete(queueKey) {
      return await redisClient.hdel(MESSAGE_QUEUES_KEY, queueKey);
    }
  };

  const messageLoadRetries = {
    async set(retryKey, count) {
      await redisClient.hset(MESSAGE_RETRIES_KEY, retryKey, count);
    },
    
    async get(retryKey) {
      const count = await redisClient.hget(MESSAGE_RETRIES_KEY, retryKey);
      return count ? parseInt(count) : 0;
    },
    
    async delete(retryKey) {
      return await redisClient.hdel(MESSAGE_RETRIES_KEY, retryKey);
    }
  };

  // 중복 로그인 처리를 위한 Redis pub/sub 채널
  const DUPLICATE_LOGIN_CHANNEL = 'duplicate_login';
  const SESSION_END_CHANNEL = 'session_end';

  // 중복 로그인 알림 발송
  const notifyDuplicateLogin = async (userId, existingSocketId, newSocketInfo) => {
    await redisClient.publish(DUPLICATE_LOGIN_CHANNEL, JSON.stringify({
      type: 'duplicate_login',
      userId,
      existingSocketId,
      newSocketInfo,
      timestamp: Date.now()
    }));
  };

  // 세션 종료 알림 발송
  const notifySessionEnd = async (userId, socketId, reason = 'logout') => {
    await redisClient.publish(SESSION_END_CHANNEL, JSON.stringify({
      type: 'session_end',
      userId,
      socketId,
      reason,
      timestamp: Date.now()
    }));
  };

  // Redis pub/sub 구독 설정
  const setupPubSubSubscriptions = async () => {
    try {
      // 중복 로그인 구독
      const duplicateLoginSubscriber = await redisClient.createSubscriber();
      duplicateLoginSubscriber.on('message', (channel, message) => {
        if (channel === DUPLICATE_LOGIN_CHANNEL) {
          try {
            const notification = JSON.parse(message);
            const targetSocket = io.sockets.sockets.get(notification.existingSocketId);
            
            if (targetSocket) {
              targetSocket.emit('duplicate_login', {
                type: 'new_login_attempt',
                deviceInfo: notification.newSocketInfo.userAgent,
                ipAddress: notification.newSocketInfo.ipAddress,
                timestamp: notification.timestamp
              });

              // 10초 후 강제 로그아웃
              setTimeout(() => {
                targetSocket.emit('session_ended', {
                  reason: 'duplicate_login',
                  message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
                });
                targetSocket.disconnect(true);
              }, 10000);
            }
          } catch (error) {
            console.error('Duplicate login notification error:', error);
          }
        }
      });
      await duplicateLoginSubscriber.subscribe(DUPLICATE_LOGIN_CHANNEL);

      // 세션 종료 구독
      const sessionEndSubscriber = await redisClient.createSubscriber();
      sessionEndSubscriber.on('message', (channel, message) => {
        if (channel === SESSION_END_CHANNEL) {
          try {
            const notification = JSON.parse(message);
            const targetSocket = io.sockets.sockets.get(notification.socketId);
            
            if (targetSocket) {
              targetSocket.emit('session_ended', {
                reason: notification.reason,
                message: '세션이 종료되었습니다.'
              });
              targetSocket.disconnect(true);
            }
          } catch (error) {
            console.error('Session end notification error:', error);
          }
        }
      });
      await sessionEndSubscriber.subscribe(SESSION_END_CHANNEL);

      // userRoomsService의 방 업데이트 구독
      await userRoomsService.subscribeRoomUpdates((notification) => {
        try {
          const { roomId, type, userId, userInfo } = notification;
          
          if (type === 'user_joined' && userInfo) {
            io.to(roomId).emit('userJoined', {
              userId,
              userInfo,
              timestamp: notification.timestamp
            });
          } else if (type === 'user_left') {
            io.to(roomId).emit('userLeft', {
              userId,
              timestamp: notification.timestamp
            });
          }
        } catch (error) {
          console.error('Room update notification error:', error);
        }
      });

      console.log('Redis pub/sub subscriptions established');
    } catch (error) {
      console.error('Failed to setup pub/sub subscriptions:', error);
    }
  };

  // Redis pub/sub 구독 설정 실행
  setupPubSubSubscriptions();

  const BATCH_SIZE = 30;
  const LOAD_DELAY = 300;
  const MAX_RETRIES = 3;
  const MESSAGE_LOAD_TIMEOUT = 10000;
  const RETRY_DELAY = 2000;
  const DUPLICATE_LOGIN_TIMEOUT = 10000;

  // 로깅 유틸리티 함수
  const logDebug = (action, data) => {
    console.debug(`[Socket.IO] ${action}:`, {
      ...data,
      timestamp: new Date().toISOString()
    });
  };

  // 메시지 일괄 로드 함수 (기존과 동일)
  const loadMessages = async (socket, roomId, before, limit = BATCH_SIZE) => {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Message loading timed out'));
      }, MESSAGE_LOAD_TIMEOUT);
    });

    try {
      const query = { room: roomId };
      if (before) {
        query.timestamp = { $lt: new Date(before) };
      }

      const messages = await Promise.race([
        Message.find(query)
          .populate('sender', 'name email profileImage')
          .populate({
            path: 'file',
            select: 'filename originalname mimetype size'
          })
          .sort({ timestamp: -1 })
          .limit(limit + 1)
          .lean(),
        timeoutPromise
      ]);

      // 결과 처리
      const hasMore = messages.length > limit;
      const resultMessages = messages.slice(0, limit);
      const sortedMessages = resultMessages.sort((a, b) => 
        new Date(a.timestamp) - new Date(b.timestamp)
      );

      // 읽음 상태 비동기 업데이트
      if (sortedMessages.length > 0 && socket.user) {
        const messageIds = sortedMessages.map(msg => msg._id);
        Message.updateMany(
          {
            _id: { $in: messageIds },
            'readers.userId': { $ne: socket.user.id }
          },
          {
            $push: {
              readers: {
                userId: socket.user.id,
                readAt: new Date()
              }
            }
          }
        ).exec().catch(error => {
          console.error('Read status update error:', error);
        });
      }

      return {
        messages: sortedMessages,
        hasMore,
        oldestTimestamp: sortedMessages[0]?.timestamp || null
      };
    } catch (error) {
      if (error.message === 'Message loading timed out') {
        logDebug('message load timeout', {
          roomId,
          before,
          limit
        });
      } else {
        console.error('Load messages error:', {
          error: error.message,
          stack: error.stack,
          roomId,
          before,
          limit
        });
      }
      throw error;
    }
  };

  // 재시도 로직을 포함한 메시지 로드 함수
  const loadMessagesWithRetry = async (socket, roomId, before, retryCount = 0) => {
    const retryKey = `${roomId}:${socket.user.id}`;
    
    try {
      const currentRetries = await messageLoadRetries.get(retryKey);
      if (currentRetries >= MAX_RETRIES) {
        throw new Error('최대 재시도 횟수를 초과했습니다.');
      }

      const result = await loadMessages(socket, roomId, before);
      await messageLoadRetries.delete(retryKey);
      return result;

    } catch (error) {
      const currentRetries = await messageLoadRetries.get(retryKey);
      
      if (currentRetries < MAX_RETRIES) {
        await messageLoadRetries.set(retryKey, currentRetries + 1);
        const delay = Math.min(RETRY_DELAY * Math.pow(2, currentRetries), 10000);
        
        logDebug('retrying message load', {
          roomId,
          retryCount: currentRetries + 1,
          delay
        });

        await new Promise(resolve => setTimeout(resolve, delay));
        return loadMessagesWithRetry(socket, roomId, before, currentRetries + 1);
      }

      await messageLoadRetries.delete(retryKey);
      throw error;
    }
  };

  // 중복 로그인 처리 함수 (Redis pub/sub 사용)
  const handleDuplicateLogin = async (existingSocketInfo, newSocket) => {
    try {
      // Redis를 통해 중복 로그인 알림 발송
      await notifyDuplicateLogin(
        newSocket.user.id,
        existingSocketInfo.socketId,
        {
          userAgent: newSocket.handshake.headers['user-agent'],
          ipAddress: newSocket.handshake.address,
          timestamp: Date.now()
        }
      );

      // 타임아웃 설정
      return new Promise((resolve) => {
        setTimeout(resolve, DUPLICATE_LOGIN_TIMEOUT);
      });
    } catch (error) {
      console.error('Duplicate login handling error:', error);
      throw error;
    }
  };

  // 미들웨어: 소켓 연결 시 인증 처리 (기존과 동일하되 Redis 사용)
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const sessionId = socket.handshake.auth.sessionId;

      if (!token || !sessionId) {
        return next(new Error('Authentication error'));
      }

      const decoded = jwt.verify(token, jwtSecret);
      if (!decoded?.user?.id) {
        return next(new Error('Invalid token'));
      }

      // Redis에서 기존 연결 확인
      const existingConnection = await connectedUsers.get(decoded.user.id);
      if (existingConnection) {
        const existingSocket = io.sockets.sockets.get(existingConnection.socketId);
        if (existingSocket) {
          // 중복 로그인 처리
          await handleDuplicateLogin(existingConnection, socket);
        }
      }

      const validationResult = await SessionService.validateSession(decoded.user.id, sessionId);
      if (!validationResult.isValid) {
        console.error('Session validation failed:', validationResult);
        return next(new Error(validationResult.message || 'Invalid session'));
      }

      const user = await User.findById(decoded.user.id);
      if (!user) {
        return next(new Error('User not found'));
      }

      socket.user = {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        sessionId: sessionId,
        profileImage: user.profileImage
      };

      await SessionService.updateLastActivity(decoded.user.id);
      next();

    } catch (error) {
      console.error('Socket authentication error:', error);
      
      if (error.name === 'TokenExpiredError') {
        return next(new Error('Token expired'));
      }
      
      if (error.name === 'JsonWebTokenError') {
        return next(new Error('Invalid token'));
      }
      
      next(new Error('Authentication failed'));
    }
  });
  
  io.on('connection', (socket) => {
    logDebug('socket connected', {
      socketId: socket.id,
      userId: socket.user?.id,
      userName: socket.user?.name
    });

    if (socket.user) {
      // Redis에서 이전 연결 확인
      connectedUsers.get(socket.user.id).then(previousConnection => {
        if (previousConnection && previousConnection.socketId !== socket.id) {
          const previousSocket = io.sockets.sockets.get(previousConnection.socketId);
          if (previousSocket) {
            // 이전 연결에 중복 로그인 알림
            notifyDuplicateLogin(
              socket.user.id,
              previousConnection.socketId,
              {
                userAgent: socket.handshake.headers['user-agent'],
                ipAddress: socket.handshake.address,
                timestamp: Date.now()
              }
            );
          }
        }
        
        // 새로운 연결 정보 Redis에 저장
        return connectedUsers.set(socket.user.id, socket.id);
      }).catch(error => {
        console.error('Connected users Redis operation error:', error);
      });
    }

    // 이전 메시지 로딩 처리 (기존과 동일하되 Redis 사용)
    socket.on('fetchPreviousMessages', async ({ roomId, before }) => {
      const queueKey = `${roomId}:${socket.user.id}`;

      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // 권한 체크
        const room = await Room.findOne({
          _id: roomId,
          participants: socket.user.id
        });

        if (!room) {
          throw new Error('채팅방 접근 권한이 없습니다.');
        }

        const isLoading = await messageQueues.get(queueKey);
        if (isLoading) {
          logDebug('message load skipped - already loading', {
            roomId,
            userId: socket.user.id
          });
          return;
        }

        await messageQueues.set(queueKey, true);
        socket.emit('messageLoadStart');

        const result = await loadMessagesWithRetry(socket, roomId, before);
        
        logDebug('previous messages loaded', {
          roomId,
          messageCount: result.messages.length,
          hasMore: result.hasMore,
          oldestTimestamp: result.oldestTimestamp
        });

        socket.emit('previousMessagesLoaded', result);

      } catch (error) {
        console.error('Fetch previous messages error:', error);
        socket.emit('error', {
          type: 'LOAD_ERROR',
          message: error.message || '이전 메시지를 불러오는 중 오류가 발생했습니다.'
        });
      } finally {
        setTimeout(async () => {
          await messageQueues.delete(queueKey);
        }, LOAD_DELAY);
      }
    });
    
    // 채팅방 입장 처리 (userRoomsService 통합)
    socket.on('joinRoom', async (roomId) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // userRoomsService에서 현재 방 확인
        const currentRoom = await userRoomsService.getUserRoom(socket.user.id);
        if (currentRoom === roomId) {
          logDebug('already in room', {
            userId: socket.user.id,
            roomId
          });
          socket.emit('joinRoomSuccess', { roomId });
          return;
        }

        // 기존 방에서 나가기 (userRoomsService 사용)
        if (currentRoom) {
          logDebug('leaving current room', { 
            userId: socket.user.id, 
            roomId: currentRoom 
          });
          socket.leave(currentRoom);
          await userRoomsService.leaveRoom(socket.user.id, currentRoom);
        }

        // 채팅방 참가
        const room = await Room.findByIdAndUpdate(
          roomId,
          { $addToSet: { participants: socket.user.id } },
          { 
            new: true,
            runValidators: true 
          }
        ).populate('participants', 'name email profileImage');

        if (!room) {
          throw new Error('채팅방을 찾을 수 없습니다.');
        }

        socket.join(roomId);
        
        // userRoomsService를 통해 방 입장 처리
        await userRoomsService.joinRoom(socket.user.id, roomId, {
          name: socket.user.name,
          socketId: socket.id,
          email: socket.user.email,
          profileImage: socket.user.profileImage
        });

        // 입장 메시지 생성
        const joinMessage = new Message({
          room: roomId,
          content: `${socket.user.name}님이 입장하였습니다.`,
          type: 'system',
          timestamp: new Date()
        });
        
        await joinMessage.save();

        // 초기 메시지 로드
        const messageLoadResult = await loadMessages(socket, roomId);
        const { messages, hasMore, oldestTimestamp } = messageLoadResult;

        // Redis에서 활성 스트리밍 메시지 조회
        const activeStreamsData = await streamingSessions.values();
        const activeStreams = activeStreamsData
          .filter(session => session.room === roomId)
          .map(session => ({
            _id: session.messageId,
            type: 'ai',
            aiType: session.aiType,
            content: session.content,
            timestamp: session.timestamp,
            isStreaming: true
          }));

        // userRoomsService에서 방 참가자 정보 조회
        const roomParticipants = await userRoomsService.getRoomParticipants(roomId);

        // 이벤트 발송
        socket.emit('joinRoomSuccess', {
          roomId,
          participants: room.participants,
          messages,
          hasMore,
          oldestTimestamp,
          activeStreams,
          onlineParticipants: Object.keys(roomParticipants)
        });

        io.to(roomId).emit('message', joinMessage);
        io.to(roomId).emit('participantsUpdate', room.participants);

        logDebug('user joined room', {
          userId: socket.user.id,
          roomId,
          messageCount: messages.length,
          hasMore,
          onlineCount: Object.keys(roomParticipants).length
        });

      } catch (error) {
        console.error('Join room error:', error);
        socket.emit('joinRoomError', {
          message: error.message || '채팅방 입장에 실패했습니다.'
        });
      }
    });
    
    // 메시지 전송 처리 (userRoomsService 활동 업데이트 추가)
    socket.on('chatMessage', async (messageData) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!messageData) {
          throw new Error('메시지 데이터가 없습니다.');
        }

        const { room, type, content, fileData } = messageData;

        if (!room) {
          throw new Error('채팅방 정보가 없습니다.');
        }

        // 채팅방 권한 확인
        const chatRoom = await Room.findOne({
          _id: room,
          participants: socket.user.id
        });

        if (!chatRoom) {
          throw new Error('채팅방 접근 권한이 없습니다.');
        }

        // 세션 유효성 재확인
        const sessionValidation = await SessionService.validateSession(
          socket.user.id, 
          socket.user.sessionId
        );
        
        if (!sessionValidation.isValid) {
          throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.');
        }

        // userRoomsService 활동 시간 업데이트
        await userRoomsService.updateUserActivity(socket.user.id);

        // AI 멘션 확인
        const aiMentions = extractAIMentions(content);
        let message;

        logDebug('message received', {
          type,
          room,
          userId: socket.user.id,
          hasFileData: !!fileData,
          hasAIMentions: aiMentions.length
        });

        // 메시지 타입별 처리
        switch (type) {
          case 'file':
            if (!fileData || !fileData._id) {
              throw new Error('파일 데이터가 올바르지 않습니다.');
            }

            const file = await File.findOne({
              _id: fileData._id,
              user: socket.user.id
            });

            if (!file) {
              throw new Error('파일을 찾을 수 없거나 접근 권한이 없습니다.');
            }

            message = new Message({
              room,
              sender: socket.user.id,
              type: 'file',
              file: file._id,
              content: content || '',
              timestamp: new Date(),
              reactions: {},
              metadata: {
                fileType: file.mimetype,
                fileSize: file.size,
                originalName: file.originalname
              }
            });
            break;

          case 'text':
            const messageContent = content?.trim() || messageData.msg?.trim();
            if (!messageContent) {
              return;
            }

            message = new Message({
              room,
              sender: socket.user.id,
              content: messageContent,
              type: 'text',
              timestamp: new Date(),
              reactions: {}
            });
            break;

          default:
            throw new Error('지원하지 않는 메시지 타입입니다.');
        }

        await message.save();
        await message.populate([
          { path: 'sender', select: 'name email profileImage' },
          { path: 'file', select: 'filename originalname mimetype size' }
        ]);

        io.to(room).emit('message', message);

        // AI 멘션이 있는 경우 AI 응답 생성
        if (aiMentions.length > 0) {
          for (const ai of aiMentions) {
            const query = content.replace(new RegExp(`@${ai}\\b`, 'g'), '').trim();
            await handleAIResponse(io, room, ai, query);
          }
        }

        await SessionService.updateLastActivity(socket.user.id);

        logDebug('message processed', {
          messageId: message._id,
          type: message.type,
          room
        });

      } catch (error) {
        console.error('Message handling error:', error);
        socket.emit('error', {
          code: error.code || 'MESSAGE_ERROR',
          message: error.message || '메시지 전송 중 오류가 발생했습니다.'
        });
      }
    });

    // 채팅방 퇴장 처리 (userRoomsService 사용)
    socket.on('leaveRoom', async (roomId) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // userRoomsService에서 현재 방 확인
        const currentRoom = await userRoomsService.getUserRoom(socket.user.id);
        if (!currentRoom || currentRoom !== roomId) {
          console.log(`User ${socket.user.id} is not in room ${roomId}`);
          return;
        }

        // 권한 확인
        const room = await Room.findOne({
          _id: roomId,
          participants: socket.user.id
        }).select('participants').lean();

        if (!room) {
          console.log(`Room ${roomId} not found or user has no access`);
          return;
        }

        socket.leave(roomId);
        
        // userRoomsService를 통해 방 퇴장 처리
        await userRoomsService.leaveRoom(socket.user.id, roomId);

        // 퇴장 메시지 생성 및 저장
        const leaveMessage = await Message.create({
          room: roomId,
          content: `${socket.user.name}님이 퇴장하였습니다.`,
          type: 'system',
          timestamp: new Date()
        });

        // 참가자 목록 업데이트
        const updatedRoom = await Room.findByIdAndUpdate(
          roomId,
          { $pull: { participants: socket.user.id } },
          { 
            new: true,
            runValidators: true
          }
        ).populate('participants', 'name email profileImage');

        if (!updatedRoom) {
          console.log(`Room ${roomId} not found during update`);
          return;
        }

        // Redis에서 스트리밍 세션 정리
        const streamingSessionsData = await streamingSessions.entries();
        for (const [messageId, session] of streamingSessionsData) {
          if (session.room === roomId && session.userId === socket.user.id) {
            await streamingSessions.delete(messageId);
          }
        }

        // 메시지 큐 정리
        const queueKey = `${roomId}:${socket.user.id}`;
        await messageQueues.delete(queueKey);
        await messageLoadRetries.delete(queueKey);

        // 이벤트 발송
        io.to(roomId).emit('message', leaveMessage);
        io.to(roomId).emit('participantsUpdate', updatedRoom.participants);

        console.log(`User ${socket.user.id} left room ${roomId} successfully`);

      } catch (error) {
        console.error('Leave room error:', error);
        socket.emit('error', {
          message: error.message || '채팅방 퇴장 중 오류가 발생했습니다.'
        });
      }
    });
    
    // 연결 해제 처리 (userRoomsService 사용)
    socket.on('disconnect', async (reason) => {
      if (!socket.user) return;

      try {
        // Redis에서 해당 사용자의 현재 활성 연결인 경우에만 정리
        const currentConnection = await connectedUsers.get(socket.user.id);
        if (currentConnection && currentConnection.socketId === socket.id) {
          await connectedUsers.delete(socket.user.id);
        }

        // userRoomsService에서 현재 방 정보 조회
        const roomId = await userRoomsService.getUserRoom(socket.user.id);

        // 메시지 큐 정리
        const allQueues = await redisClient.hgetall(MESSAGE_QUEUES_KEY);
        for (const [key, value] of Object.entries(allQueues)) {
          if (key.endsWith(`:${socket.user.id}`)) {
            await messageQueues.delete(key);
            await messageLoadRetries.delete(key);
          }
        }
        
        // 스트리밍 세션 정리
        const allSessions = await streamingSessions.entries();
        for (const [messageId, session] of allSessions) {
          if (session.userId === socket.user.id) {
            await streamingSessions.delete(messageId);
          }
        }

        // userRoomsService를 통해 방 퇴장 처리
        if (roomId) {
          // 다른 디바이스로 인한 연결 종료가 아닌 경우에만 처리
          if (reason !== 'client namespace disconnect' && reason !== 'duplicate_login') {
            await userRoomsService.leaveRoom(socket.user.id, roomId);

            const leaveMessage = await Message.create({
              room: roomId,
              content: `${socket.user.name}님이 연결이 끊어졌습니다.`,
              type: 'system',
              timestamp: new Date()
            });

            const updatedRoom = await Room.findByIdAndUpdate(
              roomId,
              { $pull: { participants: socket.user.id } },
              { 
                new: true,
                runValidators: true 
              }
            ).populate('participants', 'name email profileImage');

            if (updatedRoom) {
              io.to(roomId).emit('message', leaveMessage);
              io.to(roomId).emit('participantsUpdate', updatedRoom.participants);
            }
          } else {
            // 중복 로그인이나 강제 종료인 경우에도 userRoomsService에서 정리
            await userRoomsService.leaveRoom(socket.user.id, roomId);
          }
        }

        logDebug('user disconnected', {
          reason,
          userId: socket.user.id,
          socketId: socket.id,
          lastRoom: roomId
        });

      } catch (error) {
        console.error('Disconnect handling error:', error);
      }
    });

    // 사용자 활동 업데이트 이벤트 추가
    socket.on('updateActivity', async () => {
      try {
        if (!socket.user) return;
        
        await userRoomsService.updateUserActivity(socket.user.id);
        await SessionService.updateLastActivity(socket.user.id);
        
        logDebug('user activity updated', {
          userId: socket.user.id
        });
      } catch (error) {
        console.error('Update activity error:', error);
      }
    });

    // 방 참가자 상태 조회 이벤트 추가
    socket.on('getRoomStatus', async (roomId) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // 권한 확인
        const room = await Room.findOne({
          _id: roomId,
          participants: socket.user.id
        });

        if (!room) {
          throw new Error('채팅방 접근 권한이 없습니다.');
        }

        const roomStats = await userRoomsService.getRoomStats(roomId);
        const participants = await userRoomsService.getRoomParticipants(roomId);

        socket.emit('roomStatusUpdate', {
          roomId,
          stats: roomStats,
          onlineParticipants: Object.keys(participants),
          participantDetails: participants
        });

      } catch (error) {
        console.error('Get room status error:', error);
        socket.emit('error', {
          message: error.message || '방 상태 조회 중 오류가 발생했습니다.'
        });
      }
    });

    // 기타 이벤트 핸들러들 (기존과 동일)
    socket.on('force_login', async ({ token }) => {
      try {
        if (!socket.user) return;

        const decoded = jwt.verify(token, jwtSecret);
        if (!decoded?.user?.id || decoded.user.id !== socket.user.id) {
          throw new Error('Invalid token');
        }

        socket.emit('session_ended', {
          reason: 'force_logout',
          message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
        });

        socket.disconnect(true);

      } catch (error) {
        console.error('Force login error:', error);
        socket.emit('error', {
          message: '세션 종료 중 오류가 발생했습니다.'
        });
      }
    });

    // 메시지 읽음 상태 처리 (활동 업데이트 추가)
    socket.on('markMessagesAsRead', async ({ roomId, messageIds }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!Array.isArray(messageIds) || messageIds.length === 0) {
          return;
        }

        await Message.updateMany(
          {
            _id: { $in: messageIds },
            room: roomId,
            'readers.userId': { $ne: socket.user.id }
          },
          {
            $push: {
              readers: {
                userId: socket.user.id,
                readAt: new Date()
              }
            }
          }
        );

        // 사용자 활동 업데이트
        await userRoomsService.updateUserActivity(socket.user.id);

        socket.to(roomId).emit('messagesRead', {
          userId: socket.user.id,
          messageIds
        });

      } catch (error) {
        console.error('Mark messages as read error:', error);
        socket.emit('error', {
          message: '읽음 상태 업데이트 중 오류가 발생했습니다.'
        });
      }
    });

    // 리액션 처리 (활동 업데이트 추가)
    socket.on('messageReaction', async ({ messageId, reaction, type }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        const message = await Message.findById(messageId);
        if (!message) {
          throw new Error('메시지를 찾을 수 없습니다.');
        }

        if (type === 'add') {
          await message.addReaction(reaction, socket.user.id);
        } else if (type === 'remove') {
          await message.removeReaction(reaction, socket.user.id);
        }

        // 사용자 활동 업데이트
        await userRoomsService.updateUserActivity(socket.user.id);

        io.to(message.room).emit('messageReactionUpdate', {
          messageId,
          reactions: message.reactions
        });

      } catch (error) {
        console.error('Message reaction error:', error);
        socket.emit('error', {
          message: error.message || '리액션 처리 중 오류가 발생했습니다.'
        });
      }
    });
  });

  // 정기적인 비활성 사용자 정리 작업
  const cleanupInterval = setInterval(async () => {
    try {
      const cleanedCount = await userRoomsService.cleanupInactiveUsers();
      if (cleanedCount > 0) {
        console.log(`🧹 Cleaned up ${cleanedCount} inactive users from rooms`);
      }
    } catch (error) {
      console.error('❌ Cleanup task error:', error);
    }
  }, 10 * 60 * 1000); // 10분마다 정리

  // 서버 종료 시 정리 작업
  process.on('SIGTERM', () => {
    clearInterval(cleanupInterval);
    console.log('🔄 Chat service cleanup completed');
  });

  process.on('SIGINT', () => {
    clearInterval(cleanupInterval);
    console.log('🔄 Chat service cleanup completed');
  });

  // AI 멘션 추출 함수 (기존과 동일)
  function extractAIMentions(content) {
    if (!content) return [];
    
    const aiTypes = ['wayneAI', 'consultingAI'];
    const mentions = new Set();
    const mentionRegex = /@(wayneAI|consultingAI)\b/g;
    let match;
    
    while ((match = mentionRegex.exec(content)) !== null) {
      if (aiTypes.includes(match[1])) {
        mentions.add(match[1]);
      }
    }
    
    return Array.from(mentions);
  }

  // AI 응답 처리 함수 (Redis 사용)
  async function handleAIResponse(io, room, aiName, query) {
    const messageId = `${aiName}-${Date.now()}`;
    let accumulatedContent = '';
    const timestamp = new Date();

    // Redis에 스트리밍 세션 저장
    await streamingSessions.set(messageId, {
      room,
      aiType: aiName,
      content: '',
      messageId,
      timestamp,
      lastUpdate: Date.now(),
      reactions: {}
    });
    
    logDebug('AI response started', {
      messageId,
      aiType: aiName,
      room,
      query
    });

    io.to(room).emit('aiMessageStart', {
      messageId,
      aiType: aiName,
      timestamp
    });

    try {
      await aiService.generateResponse(query, aiName, {
        onStart: () => {
          logDebug('AI generation started', {
            messageId,
            aiType: aiName
          });
        },
        onChunk: async (chunk) => {
          accumulatedContent += chunk.currentChunk || '';
          
          // Redis에서 세션 업데이트
          const session = await streamingSessions.get(messageId);
          if (session) {
            session.content = accumulatedContent;
            session.lastUpdate = Date.now();
            await streamingSessions.set(messageId, session);
          }

          io.to(room).emit('aiMessageChunk', {
            messageId,
            currentChunk: chunk.currentChunk,
            fullContent: accumulatedContent,
            isCodeBlock: chunk.isCodeBlock,
            timestamp: new Date(),
            aiType: aiName,
            isComplete: false
          });
        },
        onComplete: async (finalContent) => {
          // Redis에서 스트리밍 세션 삭제
          await streamingSessions.delete(messageId);

          // AI 메시지 저장
          const aiMessage = await Message.create({
            room,
            content: finalContent.content,
            type: 'ai',
            aiType: aiName,
            timestamp: new Date(),
            reactions: {},
            metadata: {
              query,
              generationTime: Date.now() - timestamp,
              completionTokens: finalContent.completionTokens,
              totalTokens: finalContent.totalTokens
            }
          });

          io.to(room).emit('aiMessageComplete', {
            messageId,
            _id: aiMessage._id,
            content: finalContent.content,
            aiType: aiName,
            timestamp: new Date(),
            isComplete: true,
            query,
            reactions: {}
          });

          logDebug('AI response completed', {
            messageId,
            aiType: aiName,
            contentLength: finalContent.content.length,
            generationTime: Date.now() - timestamp
          });
        },
        onError: async (error) => {
          await streamingSessions.delete(messageId);
          console.error('AI response error:', error);
          
          io.to(room).emit('aiMessageError', {
            messageId,
            error: error.message || 'AI 응답 생성 중 오류가 발생했습니다.',
            aiType: aiName
          });

          logDebug('AI response error', {
            messageId,
            aiType: aiName,
            error: error.message
          });
        }
      });
    } catch (error) {
      await streamingSessions.delete(messageId);
      console.error('AI service error:', error);
      
      io.to(room).emit('aiMessageError', {
        messageId,
        error: error.message || 'AI 서비스 오류가 발생했습니다.',
        aiType: aiName
      });

      logDebug('AI service error', {
        messageId,
        aiType: aiName,
        error: error.message
      });
    }
  }

  // 디버깅을 위한 상태 조회 함수
  const getServiceStatus = async () => {
    try {
      const status = await userRoomsService.getStatus();
      return {
        ...status,
        connectedSockets: io.sockets.sockets.size,
        totalRooms: io.sockets.adapter.rooms.size
      };
    } catch (error) {
      console.error('Get service status error:', error);
      return {
        error: error.message,
        connectedSockets: io.sockets.sockets.size,
        totalRooms: io.sockets.adapter.rooms.size
      };
    }
  };

  // 상태 조회 API를 위한 함수 export
  io.getServiceStatus = getServiceStatus;

  return io;
};