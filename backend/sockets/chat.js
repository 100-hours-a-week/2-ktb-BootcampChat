// socket/chat.js (개선된 중복 로그인 처리)
const Message = require('../models/Message');
const Room = require('../models/Room');
const User = require('../models/User');
const File = require('../models/File');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/keys');
const redisClient = require('../utils/redisCluster');
const cacheService = require('../services/cacheService');
const SessionService = require('../services/sessionService');
const aiService = require('../services/aiService');
const { createAdapter } = require('@socket.io/redis-adapter');
const IORedis = require('ioredis');
const { redisNodes, redisPassword } = require('../config/keys');

module.exports = function(io) {
  // Socket.IO Redis 어댑터용 클라이언트 생성
  const pubClient = new IORedis.Cluster(redisNodes, {
    redisOptions: { password: redisPassword },
    scaleReads: 'slave',
    clusterRetryStrategy: attempts => Math.min(100 + attempts * 50, 2000),
    retryDelayOnFailover: 1000,
    retryDelayOnClusterDown: 1000,
  });
  const subClient = new IORedis.Cluster(redisNodes, {
    redisOptions: { password: redisPassword },
    scaleReads: 'slave',
    clusterRetryStrategy: attempts => Math.min(100 + attempts * 50, 2000),
    retryDelayOnFailover: 1000,
    retryDelayOnClusterDown: 1000,
  });

  pubClient.on('error', (err) => console.error('Redis Pub Client Error:', err));
  subClient.on('error', (err) => console.error('Redis Sub Client Error:', err));

  io.adapter(createAdapter(pubClient, subClient));

  // Redis 키 정의
  const CONNECTED_USERS_KEY = 'connectedUsers'; // Hash: userId -> JSON({ socketId, instanceId, timestamp })
  const USER_SESSIONS_KEY = 'userSessions'; // Hash: userId -> JSON({ sessionId, lastActivity, socketId, instanceId })
  const STREAMING_SESSIONS_KEY = 'streamingSessions';
  const USER_ROOMS_KEY = 'userRooms';
  const MESSAGE_QUEUES_PREFIX = 'messageQueue:';
  const MESSAGE_LOAD_RETRIES_KEY = 'messageLoadRetries';
  
  // 인스턴스 식별자 생성 (서버 시작 시)
  const INSTANCE_ID = `instance_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  const BATCH_SIZE = 30;
  const LOAD_DELAY = 300;
  const MAX_RETRIES = 3;
  const MESSAGE_LOAD_TIMEOUT = 30000;
  const RETRY_DELAY = 2000;

  console.log(`Socket.IO Instance started: ${INSTANCE_ID}`);

  // 로깅 유틸리티 함수
  const logDebug = (action, data) => {
    console.debug(`[Socket.IO][${INSTANCE_ID}] ${action}:`, {
      ...data,
      timestamp: new Date().toISOString()
    });
  };

  // 중복 로그인 처리 개선 함수
  const handleDuplicateLogin = async (userId, newSocketId, sessionId) => {
    try {
      // 기존 연결 정보 조회
      const existingConnectionStr = await redisClient.hget(CONNECTED_USERS_KEY, userId);
      const existingSessionStr = await redisClient.hget(USER_SESSIONS_KEY, userId);

      if (existingConnectionStr) {
        const existingConnection = JSON.parse(existingConnectionStr);
        const existingSocketId = existingConnection.socketId;
        const existingInstanceId = existingConnection.instanceId;

        logDebug('duplicate login detected', {
          userId,
          existingSocketId,
          existingInstanceId,
          newSocketId,
          currentInstanceId: INSTANCE_ID
        });

        // 기존 소켓에 강제 종료 신호 발송 (Redis Adapter를 통해 모든 인스턴스에 전파)
        io.emit('force_disconnect_user', {
          userId,
          targetSocketId: existingSocketId,
          reason: 'duplicate_login',
          message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.',
          newInstanceId: INSTANCE_ID
        });

        // 잠시 대기 (기존 연결이 정리될 시간 제공)
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // 새로운 연결 정보 저장
      const connectionData = {
        socketId: newSocketId,
        instanceId: INSTANCE_ID,
        timestamp: Date.now()
      };

      const sessionData = {
        sessionId,
        lastActivity: Date.now(),
        socketId: newSocketId,
        instanceId: INSTANCE_ID
      };

      await Promise.all([
        redisClient.hset(CONNECTED_USERS_KEY, userId, JSON.stringify(connectionData)),
        redisClient.hset(USER_SESSIONS_KEY, userId, JSON.stringify(sessionData))
      ]);

      logDebug('new connection established', {
        userId,
        socketId: newSocketId,
        instanceId: INSTANCE_ID
      });

    } catch (error) {
      console.error('Handle duplicate login error:', error);
      throw error;
    }
  };

  // 강제 종료 이벤트 리스너 (모든 인스턴스에서 수신)
  io.on('force_disconnect_user', async (data) => {
    const { userId, targetSocketId, reason, message, newInstanceId } = data;
    
    // 현재 인스턴스에서 해당 소켓 찾기
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    
    if (targetSocket && targetSocket.user && targetSocket.user.id === userId) {
      logDebug('force disconnecting socket', {
        userId,
        targetSocketId,
        reason,
        currentInstanceId: INSTANCE_ID,
        newInstanceId
      });

      // 클라이언트에 세션 종료 알림
      targetSocket.emit('session_ended', {
        reason,
        message
      });

      // 소켓 강제 종료
      targetSocket.disconnect(true);
    }
  });

  // 개선된 메시지 로드 함수들 (기존과 동일하게 유지)
  const loadMessages = async (socket, roomId, before, limit = BATCH_SIZE) => {
    const startTime = Date.now();
    console.log(`[loadMessages] Starting load for room ${roomId}, before: ${before}`);

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Message loading timed out after ${MESSAGE_LOAD_TIMEOUT}ms`));
      }, MESSAGE_LOAD_TIMEOUT);
    });

    try {
      const result = await Promise.race([
        loadMessagesInternal(socket, roomId, before, limit, startTime),
        timeoutPromise
      ]);

      console.log(`[loadMessages] Completed in ${Date.now() - startTime}ms`);
      return result;

    } catch (error) {
      const duration = Date.now() - startTime;
      if (error.message.includes('timed out')) {
        console.error(`[loadMessages] Timeout after ${duration}ms for room ${roomId}`);
        logDebug('message load timeout', { roomId, before, limit, duration });
      } else {
        console.error(`[loadMessages] Error after ${duration}ms:`, {
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

  const loadMessagesInternal = async (socket, roomId, before, limit, startTime) => {
    const page = before ? Math.floor(Date.now() / (1000 * 60 * 10)) : 0;

    console.log(`[loadMessages] Cache lookup started (${Date.now() - startTime}ms)`);

    let cachedResult;
    try {
      const cacheTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Cache timeout')), 3000);
      });

      cachedResult = await Promise.race([
        cacheService.getCachedMessageBatch(roomId, page),
        cacheTimeout
      ]);
    } catch (cacheError) {
      console.warn(`[loadMessages] Cache error (${Date.now() - startTime}ms):`, cacheError.message);
      cachedResult = null;
    }

    if (cachedResult && cachedResult.messages && cachedResult.messages.length > 0) {
      console.log(`[loadMessages] Cache hit: ${cachedResult.messages.length} messages (${Date.now() - startTime}ms)`);
      
      if (!before || (cachedResult.oldestTimestamp && new Date(cachedResult.oldestTimestamp) < new Date(before))) {
        logDebug('messages loaded from cache', {
          roomId,
          page,
          messageCount: cachedResult.messages.length,
          hasMore: cachedResult.hasMore,
          duration: Date.now() - startTime
        });

        if (socket.user) {
          updateReadStatusAsync(cachedResult.messages, socket.user.id).catch(err => {
            console.error('Read status update error:', err);
          });
        }

        return cachedResult;
      }
    }

    console.log(`[loadMessages] Cache miss, querying database (${Date.now() - startTime}ms)`);

    const query = { room: roomId };
    if (before) {
      query.timestamp = { $lt: new Date(before) };
    }

    const dbTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Database query timeout')), 15000);
    });

    const messages = await Promise.race([
      Message.find(query)
        .read('secondaryPreferred')
        .populate('sender', 'name email profileImage')
        .populate({
          path: 'file',
          select: 'filename originalname mimetype size'
        })
        .sort({ timestamp: -1 })
        .limit(limit + 1)
        .lean(),
      dbTimeout
    ]);

    console.log(`[loadMessages] DB query completed: ${messages.length} messages (${Date.now() - startTime}ms)`);

    const hasMore = messages.length > limit;
    const resultMessages = messages.slice(0, limit);
    const sortedMessages = resultMessages.sort((a, b) => 
      new Date(a.timestamp) - new Date(b.timestamp)
    );

    const result = {
      messages: sortedMessages,
      hasMore,
      oldestTimestamp: sortedMessages[0]?.timestamp || null
    };

    if (sortedMessages.length > 0) {
      cacheService.cacheMessageBatch(roomId, sortedMessages, page, hasMore).catch(err => {
        console.error(`[loadMessages] Cache save error (${Date.now() - startTime}ms):`, err);
      });
    }

    if (sortedMessages.length > 0 && socket.user) {
      updateReadStatusAsync(sortedMessages, socket.user.id).catch(err => {
        console.error('Read status update error:', err);
      });
    }

    logDebug('messages loaded from database', {
      roomId,
      page,
      messageCount: sortedMessages.length,
      hasMore,
      duration: Date.now() - startTime
    });

    return result;
  };

  const updateReadStatusAsync = async (messages, userId) => {
    try {
      const messageIds = messages.map(msg => msg._id);
      if (messageIds.length === 0) return;

      const updateTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Read status update timeout')), 5000);
      });

      await Promise.race([
        Message.updateMany(
          { 
            _id: { $in: messageIds },
            'readBy.user': { $ne: userId }
          },
          { 
            $push: { 
              readBy: { 
                user: userId, 
                readAt: new Date() 
              } 
            } 
          }
        ),
        updateTimeout
      ]);

    } catch (error) {
      console.error('Read status async update error:', error);
    }
  };

  const getRoomInfo = async (roomId, userId) => {
    try {
      let cachedRoom = await cacheService.getCachedRoomInfo(roomId);
      
      if (cachedRoom) {
        const hasAccess = cachedRoom.participants.some(p => 
          (typeof p === 'string' ? p : p._id?.toString()) === userId
        );
        
        if (!hasAccess) {
          throw new Error('채팅방 접근 권한이 없습니다.');
        }
        
        return cachedRoom;
      }

      const room = await Room.findOne({ _id: roomId, participants: userId })
        .read('secondaryPreferred')
        .populate('participants', 'name email profileImage')
        .lean();

      if (!room) {
        throw new Error('채팅방을 찾을 수 없습니다.');
      }

      await cacheService.cacheRoomInfo(roomId, room);
      
      return room;

    } catch (error) {
      console.error('Get room info error:', error);
      throw error;
    }
  };

  const loadMessagesWithRetry = async (socket, roomId, before, retryCount = 0) => {
    const retryKey = `${roomId}:${socket.user.id}`;
    
    try {
      const currentRetriesStr = await redisClient.hget(MESSAGE_LOAD_RETRIES_KEY, retryKey);
      const currentRetries = parseInt(currentRetriesStr || '0', 10);

      if (currentRetries >= MAX_RETRIES) {
        throw new Error('최대 재시도 횟수를 초과했습니다.');
      }

      const result = await loadMessages(socket, roomId, before);
      await redisClient.hdel(MESSAGE_LOAD_RETRIES_KEY, retryKey);
      return result;

    } catch (error) {
      const newRetryCount = await redisClient.hincrby(MESSAGE_LOAD_RETRIES_KEY, retryKey, 1);
      
      if (newRetryCount <= MAX_RETRIES) {
        const delay = Math.min(RETRY_DELAY * Math.pow(2, newRetryCount - 1), 10000);
        
        logDebug('retrying message load', {
          roomId,
          retryCount: newRetryCount,
          delay
        });

        await new Promise(resolve => setTimeout(resolve, delay));
        return loadMessagesWithRetry(socket, roomId, before, newRetryCount);
      }

      await redisClient.hdel(MESSAGE_LOAD_RETRIES_KEY, retryKey);
      throw error;
    }
  };

  // 개선된 인증 미들웨어
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

      const validationResult = await SessionService.validateSession(decoded.user.id, sessionId);
      if (!validationResult.isValid) {
        console.error('Session validation failed:', validationResult);
        return next(new Error(validationResult.message || 'Invalid session'));
      }

      const user = await User.findById(decoded.user.id).read('secondaryPreferred');
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

      // 중복 로그인 처리
      await handleDuplicateLogin(decoded.user.id, socket.id, sessionId);
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
      userName: socket.user?.name,
      instanceId: INSTANCE_ID
    });
    
    // 이전 메시지 로딩 처리
    socket.on('fetchPreviousMessages', async ({ roomId, before }) => {
      const queueKey = `${roomId}:${socket.user.id}`;

      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        await getRoomInfo(roomId, socket.user.id);

        const lockAcquired = await redisClient.set(queueKey, 'true', 'EX', 10, 'NX');

        if (!lockAcquired) {
          logDebug('message load skipped - already loading', {
            roomId,
            userId: socket.user.id
          });
          return;
        }

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
        await redisClient.del(queueKey);
      }
    });
    
    // 채팅방 입장 처리
    socket.on('joinRoom', async (roomId) => {
      try {
          if (!socket.user) {
              throw new Error('Unauthorized');
          }

          const currentRoom = await redisClient.hget(USER_ROOMS_KEY, socket.user.id);
          if (currentRoom === roomId) {
              logDebug('already in room', {
                  userId: socket.user.id,
                  roomId
              });
              socket.emit('joinRoomSuccess', { roomId });
              return;
          }

          if (currentRoom) {
              logDebug('leaving current room', {
                  userId: socket.user.id,
                  roomId: currentRoom
              });
              socket.leave(currentRoom);

              socket.to(currentRoom).emit('userLeft', {
                  userId: socket.user.id,
                  name: socket.user.name
              });
          }

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

          await cacheService.cacheRoomInfo(roomId, room);

          socket.join(roomId);
          await redisClient.hset(USER_ROOMS_KEY, socket.user.id, roomId);

          const joinMessage = new Message({
              room: roomId,
              content: `${socket.user.name}님이 입장하였습니다.`,
              type: 'system',
              timestamp: new Date()
          });

          await joinMessage.save();
          await cacheService.addMessageToCache(roomId, joinMessage);

          const messageLoadResult = await loadMessages(socket, roomId);
          const { messages, hasMore, oldestTimestamp } = messageLoadResult;

          const allSessionsRaw = await redisClient.hvals(STREAMING_SESSIONS_KEY);
          const activeStreams = allSessionsRaw
              .map(s => JSON.parse(s))
              .filter(session => session.room === roomId)
              .map(session => ({
                  _id: session.messageId,
                  type: 'ai',
                  aiType: session.aiType,
                  content: session.content,
                  timestamp: session.timestamp,
                  isStreaming: true
              }));

          socket.emit('joinRoomSuccess', {
              roomId,
              participants: room.participants,
              messages,
              hasMore,
              oldestTimestamp,
              activeStreams
          });

          io.to(roomId).emit('message', joinMessage);
          io.to(roomId).emit('participantsUpdate', room.participants);

          logDebug('user joined room', {
              userId: socket.user.id,
              roomId,
              messageCount: messages.length,
              hasMore
          });

      } catch (error) {
          console.error('Join room error:', error);
          socket.emit('joinRoomError', {
              message: error.message || '채팅방 입장에 실패했습니다.'
          });
      }
  });
    
    // 메시지 전송 처리
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

        await getRoomInfo(room, socket.user.id);

        const sessionValidation = await SessionService.validateSession(
          socket.user.id, 
          socket.user.sessionId
        );
        
        if (!sessionValidation.isValid) {
          throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.');
        }

        const aiMentions = extractAIMentions(content);
        let message;

        logDebug('message received', {
          type,
          room,
          userId: socket.user.id,
          hasFileData: !!fileData,
          hasAIMentions: aiMentions.length
        });

        switch (type) {
          case 'file':
            if (!fileData || !fileData._id) {
              throw new Error('파일 데이터가 올바르지 않습니다.');
            }

            const file = await File.findOne({
              _id: fileData._id,
              user: socket.user.id
            }).read('secondaryPreferred');

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

        cacheService.addMessageToCache(room, message)
          .then(() => io.to(room).emit('message', message))
          .catch((err) => {
            console.error('캐시 실패 → emit 강행:', err);
            io.to(room).emit('message', message);
        });

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

    // 채팅방 퇴장 처리
    socket.on('leaveRoom', async (roomId) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        const currentRoom = await redisClient.hget(USER_ROOMS_KEY, socket.user.id);
        if (!currentRoom || currentRoom !== roomId) {
          console.log(`User ${socket.user.id} is not in room ${roomId}`);
          return;
        }

        await getRoomInfo(roomId, socket.user.id);

        socket.leave(roomId);
        await redisClient.hdel(USER_ROOMS_KEY, socket.user.id);

        const leaveMessage = await Message.create({
          room: roomId,
          content: `${socket.user.name}님이 퇴장하였습니다.`,
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

        if (!updatedRoom) {
          console.log(`Room ${roomId} not found during update`);
          return;
        }

        await cacheService.cacheRoomInfo(roomId, updatedRoom);
        await cacheService.addMessageToCache(roomId, leaveMessage);
        await cacheService.invalidateUserCache(socket.user.id);

        const allSessionsRaw = await redisClient.hgetall(STREAMING_SESSIONS_KEY);
        for (const messageId in allSessionsRaw) {
            const session = JSON.parse(allSessionsRaw[messageId]);
            if (session.room === roomId && session.userId === socket.user.id) {
                await redisClient.hdel(STREAMING_SESSIONS_KEY, messageId);
            }
        }

        const queueKey = `${MESSAGE_QUEUES_PREFIX}${roomId}:${socket.user.id}`;
        await redisClient.del(queueKey);
        const retryKey = `${roomId}:${socket.user.id}`;
        await redisClient.hdel(MESSAGE_LOAD_RETRIES_KEY, retryKey);

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
    
    // 개선된 연결 해제 처리
    socket.on('disconnect', async () => {
        logDebug('socket disconnected', { 
          socketId: socket.id, 
          userId: socket.user?.id,
          instanceId: INSTANCE_ID 
        });

        if (socket.user && socket.user.id) {
            try {
                // 현재 소켓 ID와 인스턴스 ID가 모두 일치하는 경우에만 정리
                const currentConnectionStr = await redisClient.hget(CONNECTED_USERS_KEY, socket.user.id);
                const currentSessionStr = await redisClient.hget(USER_SESSIONS_KEY, socket.user.id);

                let shouldCleanup = false;

                if (currentConnectionStr) {
                    const currentConnection = JSON.parse(currentConnectionStr);
                    if (currentConnection.socketId === socket.id && 
                        currentConnection.instanceId === INSTANCE_ID) {
                        shouldCleanup = true;
                    }
                }

                if (shouldCleanup) {
                    logDebug('cleaning up user data on disconnect', {
                        userId: socket.user.id,
                        socketId: socket.id,
                        instanceId: INSTANCE_ID
                    });

                    // 연결 정보 및 세션 정보 정리
                    await Promise.all([
                        redisClient.hdel(CONNECTED_USERS_KEY, socket.user.id),
                        redisClient.hdel(USER_SESSIONS_KEY, socket.user.id)
                    ]);

                    await cacheService.invalidateUserCache(socket.user.id);

                    const roomId = await redisClient.hget(USER_ROOMS_KEY, socket.user.id);
                    if (roomId) {
                        socket.leave(roomId);
                        await redisClient.hdel(USER_ROOMS_KEY, socket.user.id);

                        // 퇴장 메시지 생성
                        const leaveMessage = new Message({
                            room: roomId,
                            content: `${socket.user.name}님이 퇴장하였습니다.`,
                            type: 'system',
                            timestamp: new Date()
                        });
                        await leaveMessage.save();
                        await cacheService.addMessageToCache(roomId, leaveMessage);

                        io.to(roomId).emit('message', leaveMessage);
                    }
                } else {
                    logDebug('skipping cleanup - connection belongs to different instance', {
                        userId: socket.user.id,
                        currentSocketId: socket.id,
                        currentInstanceId: INSTANCE_ID,
                        storedConnection: currentConnectionStr
                    });
                }

            } catch (error) {
                console.error('Disconnect handling error:', error);
            }
        }
    });

    // 강제 로그인 처리 (deprecated - 새로운 중복 로그인 처리 방식 사용)
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

    // 메시지 읽음 상태 처리
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

        await cacheService.invalidateUserCache(socket.user.id);

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

    // 리액션 처리
    socket.on('messageReaction', async ({ messageId, reaction, type }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        const message = await Message.findById(messageId).read('secondaryPreferred');
        if (!message) {
          throw new Error('메시지를 찾을 수 없습니다.');
        }

        if (type === 'add') {
          await message.addReaction(reaction, socket.user.id);
        } else if (type === 'remove') {
          await message.removeReaction(reaction, socket.user.id);
        }

        await cacheService.invalidateMessageBatch(message.room, 0);

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

    // 연결 상태 확인 (헬스체크)
    socket.on('ping', async () => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // 연결 상태 및 세션 유효성 확인
        const [connectionStr, sessionStr] = await Promise.all([
          redisClient.hget(CONNECTED_USERS_KEY, socket.user.id),
          redisClient.hget(USER_SESSIONS_KEY, socket.user.id)
        ]);

        let connectionValid = false;
        let sessionValid = false;

        if (connectionStr) {
          const connection = JSON.parse(connectionStr);
          connectionValid = connection.socketId === socket.id && 
                           connection.instanceId === INSTANCE_ID;
        }

        if (sessionStr) {
          const session = JSON.parse(sessionStr);
          const sessionValidation = await SessionService.validateSession(
            socket.user.id, 
            session.sessionId
          );
          sessionValid = sessionValidation.isValid;
        }

        if (!connectionValid || !sessionValid) {
          logDebug('invalid connection detected in ping', {
            userId: socket.user.id,
            socketId: socket.id,
            connectionValid,
            sessionValid
          });

          socket.emit('session_ended', {
            reason: 'invalid_session',
            message: '세션이 유효하지 않습니다. 다시 로그인해주세요.'
          });

          socket.disconnect(true);
          return;
        }

        // 마지막 활동 시간 업데이트
        await SessionService.updateLastActivity(socket.user.id);

        socket.emit('pong', {
          timestamp: Date.now(),
          instanceId: INSTANCE_ID
        });

      } catch (error) {
        console.error('Ping handling error:', error);
        socket.emit('error', {
          message: '연결 상태 확인 중 오류가 발생했습니다.'
        });
      }
    });
  });

  // AI 멘션 추출 함수
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

  // AI 응답 처리 함수
  async function handleAIResponse(io, room, aiName, query) {
    const messageId = `${aiName}-${Date.now()}`;
    let accumulatedContent = '';
    const timestamp = new Date();

    const sessionData = {
      room,
      aiType: aiName,
      content: '',
      messageId,
      timestamp,
      lastUpdate: Date.now(),
      reactions: {}
    };
    await redisClient.hset(STREAMING_SESSIONS_KEY, messageId, JSON.stringify(sessionData));
    
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
          
          const sessionRaw = await redisClient.hget(STREAMING_SESSIONS_KEY, messageId);
          if (sessionRaw) {
            const session = JSON.parse(sessionRaw);
            session.content = accumulatedContent;
            session.lastUpdate = Date.now();
            await redisClient.hset(STREAMING_SESSIONS_KEY, messageId, JSON.stringify(session));
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
          await redisClient.hdel(STREAMING_SESSIONS_KEY, messageId);

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

          await cacheService.addMessageToCache(room, aiMessage);

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
          await redisClient.hdel(STREAMING_SESSIONS_KEY, messageId);
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
      await redisClient.hdel(STREAMING_SESSIONS_KEY, messageId);
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

  // 정리 작업: 주기적으로 만료된 세션 및 연결 정리
  const cleanupInterval = setInterval(async () => {
    try {
      const now = Date.now();
      const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24시간

      // 만료된 연결 정리
      const allConnections = await redisClient.hgetall(CONNECTED_USERS_KEY);
      const allSessions = await redisClient.hgetall(USER_SESSIONS_KEY);

      for (const userId in allConnections) {
        const connection = JSON.parse(allConnections[userId]);
        const session = allSessions[userId] ? JSON.parse(allSessions[userId]) : null;

        // 세션이 만료되었거나 너무 오래된 연결 정리
        if (!session || (session.lastActivity && (now - session.lastActivity) > SESSION_TIMEOUT)) {
          logDebug('cleaning up expired connection', {
            userId,
            lastActivity: session?.lastActivity,
            age: session?.lastActivity ? now - session.lastActivity : 'unknown'
          });

          await Promise.all([
            redisClient.hdel(CONNECTED_USERS_KEY, userId),
            redisClient.hdel(USER_SESSIONS_KEY, userId),
            redisClient.hdel(USER_ROOMS_KEY, userId)
          ]);
        }
      }

      logDebug('cleanup completed', {
        connectionsChecked: Object.keys(allConnections).length,
        sessionsChecked: Object.keys(allSessions).length
      });

    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }, 5 * 60 * 1000); // 5분마다 실행

  // 서버 종료 시 정리
  process.on('SIGTERM', () => {
    console.log('Server shutting down, cleaning up...');
    clearInterval(cleanupInterval);
    
    // Redis 연결 정리
    if (pubClient) pubClient.disconnect();
    if (subClient) subClient.disconnect();
  });

  process.on('SIGINT', () => {
    console.log('Server interrupted, cleaning up...');
    clearInterval(cleanupInterval);
    
    // Redis 연결 정리
    if (pubClient) pubClient.disconnect();
    if (subClient) subClient.disconnect();
    process.exit(0);
  });

  return io;
};