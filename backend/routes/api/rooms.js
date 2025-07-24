const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const Room = require('../../models/Room');
const User = require('../../models/User');
const { rateLimit } = require('express-rate-limit');
const redisCluster = require('../../utils/redisCluster');
let io;

// 속도 제한 설정
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1분
  max: 60, // IP당 최대 요청 수
  message: {
    success: false,
    error: {
      message: '너무 많은 요청이 발생했습니다. 잠시 후 다시 시도해주세요.',
      code: 'TOO_MANY_REQUESTS'
    }
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Socket.IO 초기화 함수
const initializeSocket = (socketIO) => {
  io = socketIO;
};

// Redis 키 정의
const CONNECTED_USERS_KEY = 'connectedUsers';
const USER_SESSIONS_KEY = 'userSessions';

// 사용자 연결 상태 확인 함수
const checkUserConnection = async (userId) => {
  try {
    const [connectionStr, sessionStr] = await Promise.all([
      redisCluster.hget(CONNECTED_USERS_KEY, userId),
      redisCluster.hget(USER_SESSIONS_KEY, userId)
    ]);

    if (!connectionStr || !sessionStr) {
      return { isConnected: false };
    }

    const connection = JSON.parse(connectionStr);
    const session = JSON.parse(sessionStr);

    return {
      isConnected: true,
      socketId: connection.socketId,
      instanceId: connection.instanceId,
      lastActivity: session.lastActivity
    };
  } catch (error) {
    console.error('Check user connection error:', error);
    return { isConnected: false };
  }
};

// Socket.IO 이벤트 발송 시 연결 상태 확인
const safeEmit = async (event, data, roomId = null, targetUserId = null) => {
  try {
    if (!io) return;

    if (targetUserId) {
      // 특정 사용자에게만 발송하는 경우 연결 상태 확인
      const userConnection = await checkUserConnection(targetUserId);
      if (!userConnection.isConnected) {
        console.log(`User ${targetUserId} is not connected, skipping emit`);
        return;
      }
    }

    if (roomId) {
      io.to(roomId).emit(event, data);
    } else {
      io.emit(event, data);
    }
  } catch (error) {
    console.error('Safe emit error:', error);
  }
};

// 서버 상태 확인
router.get('/health', async (req, res) => {
  try {
    const isMongoConnected = require('mongoose').connection.readyState === 1;
    
    // Redis 연결 상태 확인 추가
    let isRedisConnected = false;
    try {
      const client = await redisCluster.connect();
      if (redisCluster.useMock) {
        // MockRedis의 경우 항상 연결된 것으로 간주
        isRedisConnected = true;
      } else {
        // 실제 Redis 클러스터의 경우 ping 테스트
        await client.ping();
        isRedisConnected = true;
      }
    } catch (redisError) {
      console.error('Redis health check failed:', redisError);
    }

    const recentRoom = await Room.findOne()
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean();

    const start = process.hrtime();
    await Room.findOne().select('_id').lean();
    const [seconds, nanoseconds] = process.hrtime(start);
    const latency = Math.round((seconds * 1000) + (nanoseconds / 1000000));

    const status = {
      success: true,
      timestamp: new Date().toISOString(),
      services: {
        database: {
          connected: isMongoConnected,
          latency
        },
        redis: {
          connected: isRedisConnected
        }
      },
      lastActivity: recentRoom?.createdAt
    };

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    const overallHealthy = isMongoConnected && isRedisConnected;
    res.status(overallHealthy ? 200 : 503).json(status);

  } catch (error) {
    console.error('Health check error:', error);
    res.status(503).json({
      success: false,
      error: {
        message: '서비스 상태 확인에 실패했습니다.',
        code: 'HEALTH_CHECK_FAILED'
      }
    });
  }
});

// 채팅방 목록 조회 (페이징 적용)
router.get('/', [limiter, auth], async (req, res) => {
  try {
    // 사용자 연결 상태 확인 (선택적)
    const userConnection = await checkUserConnection(req.user.id);
    
    // 쿼리 파라미터 검증 (페이지네이션)
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const pageSize = Math.min(Math.max(1, parseInt(req.query.pageSize) || 10), 50);
    const skip = page * pageSize;

    // 정렬 설정
    const allowedSortFields = ['createdAt', 'name', 'participantsCount'];
    const sortField = allowedSortFields.includes(req.query.sortField) 
      ? req.query.sortField 
      : 'createdAt';
    const sortOrder = ['asc', 'desc'].includes(req.query.sortOrder)
      ? req.query.sortOrder
      : 'desc';

    // 검색 필터 구성
    const filter = {};
    if (req.query.search) {
      filter.name = { $regex: req.query.search, $options: 'i' };
    }

    // 총 문서 수 조회
    const totalCount = await Room.countDocuments(filter);

    // 채팅방 목록 조회 with 페이지네이션
    const rooms = await Room.find(filter)
      .populate('creator', 'name email')
      .populate('participants', 'name email')
      .sort({ [sortField]: sortOrder === 'desc' ? -1 : 1 })
      .skip(skip)
      .limit(pageSize)
      .lean();

    // 안전한 응답 데이터 구성 
    const safeRooms = rooms.map(room => {
      if (!room) return null;

      const creator = room.creator || { _id: 'unknown', name: '알 수 없음', email: '' };
      const participants = Array.isArray(room.participants) ? room.participants : [];

      return {
        _id: room._id?.toString() || 'unknown',
        name: room.name || '제목 없음',
        hasPassword: !!room.hasPassword,
        creator: {
          _id: creator._id?.toString() || 'unknown',
          name: creator.name || '알 수 없음',
          email: creator.email || ''
        },
        participants: participants.filter(p => p && p._id).map(p => ({
          _id: p._id.toString(),
          name: p.name || '알 수 없음',
          email: p.email || ''
        })),
        participantsCount: participants.length,
        createdAt: room.createdAt || new Date(),
        isCreator: creator._id?.toString() === req.user.id,
      };
    }).filter(room => room !== null);

    // 메타데이터 계산    
    const totalPages = Math.ceil(totalCount / pageSize);
    const hasMore = skip + rooms.length < totalCount;

    // 캐시 설정
    res.set({
      'Cache-Control': 'private, max-age=10',
      'Last-Modified': new Date().toUTCString()
    });

    // 응답 전송 (연결 상태 정보 포함)
    res.json({
      success: true,
      data: safeRooms,
      metadata: {
        total: totalCount,
        page,
        pageSize,
        totalPages,
        hasMore,
        currentCount: safeRooms.length,
        sort: {
          field: sortField,
          order: sortOrder
        },
        userConnection: {
          isConnected: userConnection.isConnected,
          lastActivity: userConnection.lastActivity
        }
      }
    });

  } catch (error) {
    console.error('방 목록 조회 에러:', error);
    const errorResponse = {
      success: false,
      error: {
        message: '채팅방 목록을 불러오는데 실패했습니다.',
        code: 'ROOMS_FETCH_ERROR'
      }
    };

    if (process.env.NODE_ENV === 'development') {
      errorResponse.error.details = error.message;
      errorResponse.error.stack = error.stack;
    }

    res.status(500).json(errorResponse);
  }
});

// 채팅방 생성
router.post('/', auth, async (req, res) => {
  try {
    // 사용자 연결 상태 확인
    const userConnection = await checkUserConnection(req.user.id);
    if (!userConnection.isConnected) {
      return res.status(401).json({
        success: false,
        error: {
          message: '연결이 끊어졌습니다. 다시 로그인해주세요.',
          code: 'USER_DISCONNECTED'
        }
      });
    }

    const { name, password } = req.body;
    
    if (!name?.trim()) {
      return res.status(400).json({ 
        success: false,
        message: '방 이름은 필수입니다.' 
      });
    }

    const newRoom = new Room({
      name: name.trim(),
      creator: req.user.id,
      participants: [req.user.id],
      password: password
    });

    const savedRoom = await newRoom.save();
    const populatedRoom = await Room.findById(savedRoom._id)
      .populate('creator', 'name email')
      .populate('participants', 'name email');
    
    // Socket.IO를 통해 새 채팅방 생성 알림 (연결 상태 확인 후)
    await safeEmit('roomCreated', {
      ...populatedRoom.toObject(),
      password: undefined
    }, 'room-list');
    
    res.status(201).json({
      success: true,
      data: {
        ...populatedRoom.toObject(),
        password: undefined
      }
    });
  } catch (error) {
    console.error('방 생성 에러:', error);
    res.status(500).json({ 
      success: false,
      message: '서버 에러가 발생했습니다.',
      error: error.message 
    });
  }
});

// 특정 채팅방 조회
router.get('/:roomId', auth, async (req, res) => {
  try {
    // 사용자 연결 상태 확인
    const userConnection = await checkUserConnection(req.user.id);
    
    const room = await Room.findById(req.params.roomId)
      .populate('creator', 'name email')
      .populate('participants', 'name email');

    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    res.json({
      success: true,
      data: {
        ...room.toObject(),
        password: undefined
      },
      metadata: {
        userConnection: {
          isConnected: userConnection.isConnected,
          lastActivity: userConnection.lastActivity
        }
      }
    });
  } catch (error) {
    console.error('Room fetch error:', error);
    res.status(500).json({
      success: false,
      message: '채팅방 정보를 불러오는데 실패했습니다.'
    });
  }
});

// 채팅방 입장
router.post('/:roomId/join', auth, async (req, res) => {
  try {
    // 사용자 연결 상태 확인
    const userConnection = await checkUserConnection(req.user.id);
    if (!userConnection.isConnected) {
      return res.status(401).json({
        success: false,
        error: {
          message: '연결이 끊어졌습니다. 다시 로그인해주세요.',
          code: 'USER_DISCONNECTED'
        }
      });
    }

    const { password } = req.body;
    const room = await Room.findById(req.params.roomId).select('+password');
    
    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    // 비밀번호 확인
    if (room.hasPassword) {
      const isPasswordValid = await room.checkPassword(password);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          message: '비밀번호가 일치하지 않습니다.'
        });
      }
    }

    // 참여자 목록에 추가
    if (!room.participants.includes(req.user.id)) {
      room.participants.push(req.user.id);
      await room.save();
    }

    const populatedRoom = await room.populate('participants', 'name email');

    // Socket.IO를 통해 참여자 업데이트 알림 (연결된 사용자들에게만)
    await safeEmit('roomUpdate', {
      ...populatedRoom.toObject(),
      password: undefined
    }, req.params.roomId);

    res.json({
      success: true,
      data: {
        ...populatedRoom.toObject(),
        password: undefined
      }
    });
  } catch (error) {
    console.error('방 입장 에러:', error);
    res.status(500).json({
      success: false,
      message: '서버 에러가 발생했습니다.',
      error: error.message
    });
  }
});

// 채팅방 나가기 (추가)
router.post('/:roomId/leave', auth, async (req, res) => {
  try {
    // 사용자 연결 상태 확인
    const userConnection = await checkUserConnection(req.user.id);
    
    const room = await Room.findById(req.params.roomId);
    
    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    // 참여자 목록에서 제거
    room.participants = room.participants.filter(
      participant => participant.toString() !== req.user.id
    );
    
    await room.save();

    // 연결된 사용자가 있는 경우에만 Socket.IO 이벤트 발송
    if (userConnection.isConnected) {
      await safeEmit('userLeft', {
        userId: req.user.id,
        roomId: req.params.roomId
      }, req.params.roomId);
    }

    res.json({
      success: true,
      message: '채팅방에서 나갔습니다.'
    });
  } catch (error) {
    console.error('방 나가기 에러:', error);
    res.status(500).json({
      success: false,
      message: '서버 에러가 발생했습니다.',
      error: error.message
    });
  }
});

module.exports = {
  router,
  initializeSocket
};