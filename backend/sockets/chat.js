// socket/chat.js (Redis 캐싱 적용 버전)
const Message = require('../models/Message');
const Room = require('../models/Room');
const User = require('../models/User');
const File = require('../models/File');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/keys');
const redisClient = require('../utils/redisClient');
const cacheService = require('../services/cacheService');
const SessionService = require('../services/sessionService');
const aiService = require('../services/aiService');

module.exports = function(io) {
  const connectedUsers = new Map();
  const streamingSessions = new Map();
  const userRooms = new Map();
  const messageQueues = new Map();
  const messageLoadRetries = new Map();
  
  const BATCH_SIZE = 30;
  const LOAD_DELAY = 300;
  const MAX_RETRIES = 3;
  const MESSAGE_LOAD_TIMEOUT = 30000;
  const RETRY_DELAY = 2000;
  const DUPLICATE_LOGIN_TIMEOUT = 10000;

  // 로깅 유틸리티 함수
  const logDebug = (action, data) => {
    console.debug(`[Socket.IO] ${action}:`, {
      ...data,
      timestamp: new Date().toISOString()
    });
  };

  // 개선된 메시지 로드 함수 (Redis 캐싱 적용)
  const loadMessages = async (socket, roomId, before, limit = BATCH_SIZE) => {
    const startTime = Date.now();
    console.log(`[loadMessages] Starting load for room ${roomId}, before: ${before}`);

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Message loading timed out after ${MESSAGE_LOAD_TIMEOUT}ms`));
      }, MESSAGE_LOAD_TIMEOUT);
    });

    try {
      // 전체 로직을 Promise.race로 타임아웃 적용
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

  // 내부 로직을 별도 함수로 분리
  const loadMessagesInternal = async (socket, roomId, before, limit, startTime) => {
    // 1. 간단한 페이지 계산 (복잡한 계산 제거)
    const page = before ? Math.floor(Date.now() / (1000 * 60 * 10)) : 0; // 10분 단위로 페이지 구분

    console.log(`[loadMessages] Cache lookup started (${Date.now() - startTime}ms)`);

    // 2. 캐시 조회 (타임아웃 적용)
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

    // 3. 캐시 히트 처리
    if (cachedResult && cachedResult.messages && cachedResult.messages.length > 0) {
      console.log(`[loadMessages] Cache hit: ${cachedResult.messages.length} messages (${Date.now() - startTime}ms)`);
      
      // before 조건 확인
      if (!before || (cachedResult.oldestTimestamp && new Date(cachedResult.oldestTimestamp) < new Date(before))) {
        logDebug('messages loaded from cache', {
          roomId,
          page,
          messageCount: cachedResult.messages.length,
          hasMore: cachedResult.hasMore,
          duration: Date.now() - startTime
        });

        // 읽음 상태 비동기 업데이트
        if (socket.user) {
          updateReadStatusAsync(cachedResult.messages, socket.user.id).catch(err => {
            console.error('Read status update error:', err);
          });
        }

        return cachedResult;
      }
    }

    console.log(`[loadMessages] Cache miss, querying database (${Date.now() - startTime}ms)`);

    // 4. 데이터베이스 쿼리 (단일 쿼리로 최적화)
    const query = { room: roomId };
    if (before) {
      query.timestamp = { $lt: new Date(before) };
    }

    // 데이터베이스 쿼리에 개별 타임아웃 적용
    const dbTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Database query timeout')), 15000);
    });

    const messages = await Promise.race([
      Message.find(query)
        .populate('sender', 'name email profileImage')
        .populate({
          path: 'file',
          select: 'filename originalname mimetype size'
        })
        .sort({ timestamp: -1 })
        .limit(limit + 1)
        .lean(), // lean() 사용으로 성능 향상
      dbTimeout
    ]);

    console.log(`[loadMessages] DB query completed: ${messages.length} messages (${Date.now() - startTime}ms)`);

    // 5. 결과 처리
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

    // 6. 캐시 저장 (비동기 처리로 응답 지연 방지)
    if (sortedMessages.length > 0) {
      cacheService.cacheMessageBatch(roomId, sortedMessages, page, hasMore).catch(err => {
        console.error(`[loadMessages] Cache save error (${Date.now() - startTime}ms):`, err);
      });
    }

    // 7. 읽음 상태 비동기 업데이트
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

  // 읽음 상태 업데이트를 더 안전하게 처리
  const updateReadStatusAsync = async (messages, userId) => {
    try {
      const messageIds = messages.map(msg => msg._id);
      if (messageIds.length === 0) return;

      // 타임아웃 적용
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
      // 읽음 상태 업데이트 실패는 로그만 남기고 에러를 던지지 않음
    }
  };

  // 채팅방 정보 조회 (캐싱 적용)
  const getRoomInfo = async (roomId, userId) => {
    try {
      // 캐시에서 먼저 조회
      let cachedRoom = await cacheService.getCachedRoomInfo(roomId);
      
      if (cachedRoom) {
        // 권한 확인
        const hasAccess = cachedRoom.participants.some(p => 
          (typeof p === 'string' ? p : p._id?.toString()) === userId
        );
        
        if (!hasAccess) {
          throw new Error('채팅방 접근 권한이 없습니다.');
        }
        
        return cachedRoom;
      }

      // 캐시 미스 - DB에서 조회
      const room = await Room.findOne({
        _id: roomId,
        participants: userId
      }).populate('participants', 'name email profileImage').lean();

      if (!room) {
        throw new Error('채팅방을 찾을 수 없습니다.');
      }

      // 캐시에 저장
      await cacheService.cacheRoomInfo(roomId, room);
      
      return room;

    } catch (error) {
      console.error('Get room info error:', error);
      throw error;
    }
  };

  // 재시도 로직을 포함한 메시지 로드 함수
  const loadMessagesWithRetry = async (socket, roomId, before, retryCount = 0) => {
    const retryKey = `${roomId}:${socket.user.id}`;
    
    try {
      if (messageLoadRetries.get(retryKey) >= MAX_RETRIES) {
        throw new Error('최대 재시도 횟수를 초과했습니다.');
      }

      const result = await loadMessages(socket, roomId, before);
      messageLoadRetries.delete(retryKey);
      return result;

    } catch (error) {
      const currentRetries = messageLoadRetries.get(retryKey) || 0;
      
      if (currentRetries < MAX_RETRIES) {
        messageLoadRetries.set(retryKey, currentRetries + 1);
        const delay = Math.min(RETRY_DELAY * Math.pow(2, currentRetries), 10000);
        
        logDebug('retrying message load', {
          roomId,
          retryCount: currentRetries + 1,
          delay
        });

        await new Promise(resolve => setTimeout(resolve, delay));
        return loadMessagesWithRetry(socket, roomId, before, currentRetries + 1);
      }

      messageLoadRetries.delete(retryKey);
      throw error;
    }
  };

  // 중복 로그인 처리 함수 (기존과 동일)
  const handleDuplicateLogin = async (existingSocket, newSocket) => {
    try {
      existingSocket.emit('duplicate_login', {
        type: 'new_login_attempt',
        deviceInfo: newSocket.handshake.headers['user-agent'],
        ipAddress: newSocket.handshake.address,
        timestamp: Date.now()
      });

      return new Promise((resolve) => {
        setTimeout(async () => {
          try {
            existingSocket.emit('session_ended', {
              reason: 'duplicate_login',
              message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
            });
            existingSocket.disconnect(true);
            resolve();
          } catch (error) {
            console.error('Error during session termination:', error);
            resolve();
          }
        }, DUPLICATE_LOGIN_TIMEOUT);
      });
    } catch (error) {
      console.error('Duplicate login handling error:', error);
      throw error;
    }
  };

  // 미들웨어: 소켓 연결 시 인증 처리 (기존과 동일)
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

      const existingSocketId = connectedUsers.get(decoded.user.id);
      if (existingSocketId) {
        const existingSocket = io.sockets.sockets.get(existingSocketId);
        if (existingSocket) {
          await handleDuplicateLogin(existingSocket, socket);
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
      const previousSocketId = connectedUsers.get(socket.user.id);
      if (previousSocketId && previousSocketId !== socket.id) {
        const previousSocket = io.sockets.sockets.get(previousSocketId);
        if (previousSocket) {
          previousSocket.emit('duplicate_login', {
            type: 'new_login_attempt',
            deviceInfo: socket.handshake.headers['user-agent'],
            ipAddress: socket.handshake.address,
            timestamp: Date.now()
          });

          setTimeout(() => {
            previousSocket.emit('session_ended', {
              reason: 'duplicate_login',
              message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
            });
            previousSocket.disconnect(true);
          }, DUPLICATE_LOGIN_TIMEOUT);
        }
      }
      
      connectedUsers.set(socket.user.id, socket.id);
    }

    // 이전 메시지 로딩 처리 (캐싱 적용)
    socket.on('fetchPreviousMessages', async ({ roomId, before }) => {
      const queueKey = `${roomId}:${socket.user.id}`;

      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // 권한 체크 (캐시 우선 조회)
        await getRoomInfo(roomId, socket.user.id);

        if (messageQueues.get(queueKey)) {
          logDebug('message load skipped - already loading', {
            roomId,
            userId: socket.user.id
          });
          return;
        }

        messageQueues.set(queueKey, true);
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
        setTimeout(() => {
          messageQueues.delete(queueKey);
        }, LOAD_DELAY);
      }
    });
    
    // 채팅방 입장 처리 (캐싱 적용)
    socket.on('joinRoom', async (roomId) => {
      try {
          if (!socket.user) {
              throw new Error('Unauthorized');
          }

          const currentRoom = userRooms.get(socket.user.id);
          if (currentRoom === roomId) {
              logDebug('already in room', {
                  userId: socket.user.id,
                  roomId
              });
              socket.emit('joinRoomSuccess', { roomId });
              return;
          }

          // 기존 방에서 나가기
          if (currentRoom) {
              logDebug('leaving current room', {
                  userId: socket.user.id,
                  roomId: currentRoom
              });
              socket.leave(currentRoom);
              userRooms.delete(socket.user.id);

              socket.to(currentRoom).emit('userLeft', {
                  userId: socket.user.id,
                  name: socket.user.name
              });
          }

          // 채팅방 참가 처리
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

          // 🌟 이제 cacheService가 정의되어 있으므로 호출할 수 있습니다.
          await cacheService.cacheRoomInfo(roomId, room); // <--- 여기가 원래 515번째 줄

          socket.join(roomId);
          userRooms.set(socket.user.id, roomId);

          // 입장 메시지 생성
          const joinMessage = new Message({
              room: roomId,
              content: `${socket.user.name}님이 입장하였습니다.`,
              type: 'system',
              timestamp: new Date()
          });

          await joinMessage.save();

          // 🌟 캐시에 새 메시지 추가 (이것도 cacheService에 있으므로 문제 해결)
          await cacheService.addMessageToCache(roomId, joinMessage);

          // 초기 메시지 로드
          const messageLoadResult = await loadMessages(socket, roomId);
          const { messages, hasMore, oldestTimestamp } = messageLoadResult;

          // 활성 스트리밍 메시지 조회
          const activeStreams = Array.from(streamingSessions.values())
              .filter(session => session.room === roomId)
              .map(session => ({
                  _id: session.messageId,
                  type: 'ai',
                  aiType: session.aiType,
                  content: session.content,
                  timestamp: session.timestamp,
                  isStreaming: true
              }));

          // 이벤트 발송
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
    
    // 메시지 전송 처리 (캐싱 적용)
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

        // 채팅방 권한 확인 (캐시 우선 조회)
        await getRoomInfo(room, socket.user.id);

        // 세션 유효성 재확인
        const sessionValidation = await SessionService.validateSession(
          socket.user.id, 
          socket.user.sessionId
        );
        
        if (!sessionValidation.isValid) {
          throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.');
        }

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

        // 캐시에 새 메시지 추가
        // await cacheService.addMessageToCache(room, message);
        cacheService.addMessageToCache(room, message)
          .then(() => io.to(room).emit('message', message))
          .catch((err) => {
            console.error('캐시 실패 → emit 강행:', err);
            io.to(room).emit('message', message);  // fallback emit
        });

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

    // 채팅방 퇴장 처리 (캐싱 적용)
    socket.on('leaveRoom', async (roomId) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        const currentRoom = userRooms?.get(socket.user.id);
        if (!currentRoom || currentRoom !== roomId) {
          console.log(`User ${socket.user.id} is not in room ${roomId}`);
          return;
        }

        // 권한 확인 (캐시 우선 조회)
        const room = await getRoomInfo(roomId, socket.user.id);

        socket.leave(roomId);
        userRooms.delete(socket.user.id);

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

        // 캐시 업데이트
        await cacheService.cacheRoomInfo(roomId, updatedRoom);
        await cacheService.addMessageToCache(roomId, leaveMessage);
        await cacheService.invalidateUserCache(socket.user.id);

        // 스트리밍 세션 정리
        for (const [messageId, session] of streamingSessions.entries()) {
          if (session.room === roomId && session.userId === socket.user.id) {
            streamingSessions.delete(messageId);
          }
        }

        // 메시지 큐 정리
        const queueKey = `${roomId}:${socket.user.id}`;
        messageQueues.delete(queueKey);
        messageLoadRetries.delete(queueKey);

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
    
    // 연결 해제 처리 (캐싱 적용) - 수정된 부분
    socket.on('disconnect', async () => {
        logDebug('socket disconnected', { socketId: socket.id, userId: socket.user?.id });

        // 사용자 캐시 무효화 및 방 제거 (로그아웃 처리 시)
        if (socket.user && socket.user.id) {
            try {
                // 🌟 cacheService가 이제 유효합니다.
                // 따라서 invalidateUserCache 호출 시 TypeError가 발생하지 않을 것입니다.
                await cacheService.invalidateUserCache(socket.user.id); // <--- 여기가 원래 844번째 줄

                const roomId = userRooms.get(socket.user.id);
                if (roomId) {
                    socket.leave(roomId);
                    userRooms.delete(socket.user.id);

                    // 방에서 나갔다는 메시지 전송
                    const leaveMessage = new Message({
                        room: roomId,
                        content: `${socket.user.name}님이 퇴장하였습니다.`,
                        type: 'system',
                        timestamp: new Date()
                    });
                    await leaveMessage.save();
                    // 🌟 cacheService가 이제 유효합니다.
                    await cacheService.addMessageToCache(roomId, leaveMessage); // 캐시 업데이트

                    io.to(roomId).emit('message', leaveMessage);

                    // 참여자 목록 업데이트 (선택 사항, 필요하다면 해당 로직 추가)
                    // const room = await Room.findById(roomId);
                    // if (room) {
                    //     io.to(roomId).emit('participantsUpdate', room.participants);
                    // }
                }

            } catch (error) {
                // disconnect 처리 중 발생한 오류 로깅
                console.error('Disconnect handling error:', error);
            }
        }
    });

    // 세션 종료 또는 로그아웃 처리 (기존과 동일)
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

    // 메시지 읽음 상태 처리 (캐싱 적용)
    socket.on('markMessagesAsRead', async ({ roomId, messageIds }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!Array.isArray(messageIds) || messageIds.length === 0) {
          return;
        }

        // 읽음 상태 업데이트
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

        // 읽지 않은 메시지 수 캐시 무효화
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

    // 리액션 처리 (캐싱 적용)
    socket.on('messageReaction', async ({ messageId, reaction, type }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        const message = await Message.findById(messageId);
        if (!message) {
          throw new Error('메시지를 찾을 수 없습니다.');
        }

        // 리액션 추가/제거
        if (type === 'add') {
          await message.addReaction(reaction, socket.user.id);
        } else if (type === 'remove') {
          await message.removeReaction(reaction, socket.user.id);
        }

        // 메시지 캐시 무효화 (리액션 변경으로 인한)
        await cacheService.invalidateMessageBatch(message.room, 0);

        // 업데이트된 리액션 정보 브로드캐스트
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

  // AI 응답 처리 함수 (캐싱 적용)
  async function handleAIResponse(io, room, aiName, query) {
    const messageId = `${aiName}-${Date.now()}`;
    let accumulatedContent = '';
    const timestamp = new Date();

    // 스트리밍 세션 초기화
    streamingSessions.set(messageId, {
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

    // 초기 상태 전송
    io.to(room).emit('aiMessageStart', {
      messageId,
      aiType: aiName,
      timestamp
    });

    try {
      // AI 응답 생성 및 스트리밍
      await aiService.generateResponse(query, aiName, {
        onStart: () => {
          logDebug('AI generation started', {
            messageId,
            aiType: aiName
          });
        },
        onChunk: async (chunk) => {
          accumulatedContent += chunk.currentChunk || '';
          
          const session = streamingSessions.get(messageId);
          if (session) {
            session.content = accumulatedContent;
            session.lastUpdate = Date.now();
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
          // 스트리밍 세션 정리
          streamingSessions.delete(messageId);

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

          // 캐시에 AI 메시지 추가
          await cacheService.addMessageToCache(room, aiMessage);

          // 완료 메시지 전송
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
        onError: (error) => {
          streamingSessions.delete(messageId);
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
      streamingSessions.delete(messageId);
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

  return io;
};