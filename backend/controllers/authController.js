const User = require('../models/User');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/keys');
const SessionService = require('../services/sessionService');
const { s3Bucket, s3Folder, cloudfrontBaseUrl } = require('../config/keys');

const authController = {
  async register(req, res) {
    try {
      console.log('Register request received:', req.body);
      
      const { name, email, password } = req.body;

      // Input validation
      if (!name || !email || !password) {
        return res.status(400).json({
          success: false,
          message: '모든 필드를 입력해주세요.'
        });
      }

      if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
        return res.status(400).json({
          success: false,
          message: '올바른 이메일 형식이 아닙니다.'
        });
      }

      if (password.length < 6) {
        return res.status(400).json({
          success: false,
          message: '비밀번호는 6자 이상이어야 합니다.'
        });
      }
      
      // Check existing user
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(409).json({
          success: false,
          message: '이미 등록된 이메일입니다.'
        });
      }
      
      // Create user
      const user = new User({
        name,
        email,
        password
      });

      await user.save();
      console.log('User created:', user._id);

      // Create session with metadata
      const sessionInfo = await SessionService.createSession(user._id, {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
        deviceInfo: req.headers['user-agent'],
        createdAt: Date.now()
      });
      
      if (!sessionInfo || !sessionInfo.sessionId) {
        throw new Error('Session creation failed');
      }

      // Generate token with additional claims
      const token = jwt.sign(
        { 
          user: { id: user._id },
          sessionId: sessionInfo.sessionId,
          iat: Math.floor(Date.now() / 1000)
        },
        jwtSecret,
        { 
          expiresIn: '24h',
          algorithm: 'HS256'
        }
      );

      res.status(201).json({
        success: true,
        message: '회원가입이 완료되었습니다.',
        token,
        sessionId: sessionInfo.sessionId,
        user: {
          _id: user._id,
          name: user.name,
          email: user.email
        }
      });

    } catch (error) {
      console.error('Register error:', error);
      
      if (error.name === 'ValidationError') {
        return res.status(400).json({
          success: false,
          message: '입력값이 올바르지 않습니다.',
          errors: Object.values(error.errors).map(err => err.message)
        });
      }
      
      res.status(500).json({
        success: false,
        message: '회원가입 처리 중 오류가 발생했습니다.'
      });
    }
  },

  async login(req, res) {
    try {
      const { email, password } = req.body;

      // Input validation
      if (!email || !password) {
        return res.status(400).json({
          success: false,
          message: '이메일과 비밀번호를 입력해주세요.'
        });
      }

      // 사용자 조회
      const user = await User.findOne({ email }).select('+password');
      if (!user) {
        return res.status(401).json({
          success: false,
          message: '이메일 또는 비밀번호가 올바르지 않습니다.'
        });
      }

      // 비밀번호 확인
      const isMatch = await user.matchPassword(password);
      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: '이메일 또는 비밀번호가 올바르지 않습니다.'
        });
      }

      // Redis Cluster 상태 확인 및 모드 결정
      const clusterStatus = await SessionService.getClusterStatus();
      console.log('Redis Cluster status:', clusterStatus);

      if (!clusterStatus.isHealthy) {
        // 클러스터가 불안정하거나 사용 불가능한 경우
        console.log('Redis Cluster unhealthy, using in-memory session management for user:', user._id);
        await this.handleInMemoryLogin(req, res, user, clusterStatus);
        return;
      }

      // Redis Cluster가 정상인 경우 클러스터 기반 로그인 처리
      await this.handleClusterLogin(req, res, user, clusterStatus);

    } catch (error) {
      console.error('Login error:', error);
      
      if (error.message === 'INVALID_TOKEN') {
        return res.status(401).json({
          success: false,
          message: '인증 토큰이 유효하지 않습니다.'
        });
      }

      if (error.code === 'CLUSTERDOWN' || error.code === 'CLUSTERFAIL') {
        console.error('Redis Cluster error during login:', error);
        // 클러스터 오류 시 인메모리 모드로 fallback
        try {
          const user = await User.findOne({ email: req.body.email });
          if (user) {
            await this.handleInMemoryLogin(req, res, user, { isHealthy: false, mode: 'fallback' });
            return;
          }
        } catch (fallbackError) {
          console.error('Fallback login failed:', fallbackError);
        }
      }
      
      res.status(500).json({
        success: false,
        message: '로그인 처리 중 오류가 발생했습니다.',
        code: error.code || 'UNKNOWN_ERROR'
      });
    }
  },

  // 인메모리 모드 로그인 처리 (클러스터 상태 정보 포함)
  async handleInMemoryLogin(req, res, user, clusterStatus = {}) {
    try {
      // 기존 세션 모두 제거 (인메모리에서는 단순하게 처리)
      await SessionService.removeAllUserSessions(user._id);
      
      // 새 세션 생성
      const sessionInfo = await SessionService.createSession(user._id, {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
        deviceInfo: req.headers['user-agent'],
        loginAt: Date.now(),
        mode: 'in-memory',
        clusterStatus: clusterStatus.mode || 'unavailable',
        fallbackReason: clusterStatus.error || 'cluster_unavailable'
      });

      if (!sessionInfo || !sessionInfo.sessionId) {
        throw new Error('Session creation failed');
      }

      // JWT 토큰 생성
      const token = jwt.sign(
        { 
          user: { id: user._id },
          sessionId: sessionInfo.sessionId,
          iat: Math.floor(Date.now() / 1000),
          mode: 'in-memory'
        },
        jwtSecret,
        { 
          expiresIn: '24h',
          algorithm: 'HS256'
        }
      );

      // 응답 헤더 설정
      res.set({
        'Authorization': `Bearer ${token}`,
        'x-session-id': sessionInfo.sessionId,
        'x-session-mode': 'in-memory',
        'x-cluster-status': clusterStatus.mode || 'unavailable'
      });

      const key = user.profileImage;
      let profileImage = `${cloudfrontBaseUrl}/${key}`;

      if (key === '') {
        profileImage = key;
      }

      res.json({
        success: true,
        token,
        sessionId: sessionInfo.sessionId,
        mode: 'in-memory',
        clusterStatus: clusterStatus.mode || 'unavailable',
        warning: '현재 Redis Cluster가 사용 불가능하여 임시 세션으로 동작합니다.',
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          profileImage
        }
      });

    } catch (error) {
      console.error('In-memory login error:', error);
      throw error;
    }
  },

  // Redis Cluster 모드 로그인 처리
  async handleClusterLogin(req, res, user, clusterStatus) {
    try {
      // 클러스터의 모든 노드에서 기존 세션 확인
      let existingSession = null;
      const maxRetries = 3;
      let retryCount = 0;

      while (retryCount < maxRetries && !existingSession) {
        try {
          existingSession = await SessionService.getActiveSessionFromCluster(user._id);
          break;
        } catch (sessionError) {
          retryCount++;
          console.error(`Session check attempt ${retryCount} failed:`, sessionError);
          
          if (sessionError.code === 'CLUSTERDOWN' || sessionError.code === 'MOVED' || sessionError.code === 'ASK') {
            // 클러스터 재구성 중인 경우 잠시 대기
            await new Promise(resolve => setTimeout(resolve, 100 * retryCount));
          } else if (retryCount >= maxRetries) {
            console.error('Max retries reached for session check, removing all sessions');
            await SessionService.removeAllUserSessionsFromCluster(user._id);
            break;
          }
        }
      }

      if (existingSession) {
        const duplicateLoginResult = await this.handleClusterDuplicateLogin(req, user, existingSession, clusterStatus);
        
        if (!duplicateLoginResult.shouldProceed) {
          return res.status(409).json({
            success: false,
            code: duplicateLoginResult.code,
            message: duplicateLoginResult.message
          });
        }
      }

      // 새 세션 생성 (클러스터 환경에서 분산 저장)
      const sessionInfo = await SessionService.createClusterSession(user._id, {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
        deviceInfo: req.headers['user-agent'],
        loginAt: Date.now(),
        browser: req.headers['user-agent'],
        platform: req.headers['sec-ch-ua-platform'],
        location: req.headers['x-forwarded-for'] || req.connection.remoteAddress,
        mode: 'redis-cluster',
        clusterNodes: clusterStatus.nodes || [],
        masterNode: clusterStatus.masterNode
      });

      if (!sessionInfo || !sessionInfo.sessionId) {
        throw new Error('Cluster session creation failed');
      }

      // JWT 토큰 생성
      const token = jwt.sign(
        { 
          user: { id: user._id },
          sessionId: sessionInfo.sessionId,
          iat: Math.floor(Date.now() / 1000),
          mode: 'redis-cluster'
        },
        jwtSecret,
        { 
          expiresIn: '24h',
          algorithm: 'HS256'
        }
      );

      // 응답 헤더 설정
      res.set({
        'Authorization': `Bearer ${token}`,
        'x-session-id': sessionInfo.sessionId,
        'x-session-mode': 'redis-cluster',
        'x-cluster-status': 'healthy',
        'x-cluster-nodes': clusterStatus.nodes?.length || 0
      });

      const key = user.profileImage;
      let profileImage = `${cloudfrontBaseUrl}/${key}`;

      if (key === '') {
        profileImage = key;
      }

      res.json({
        success: true,
        token,
        sessionId: sessionInfo.sessionId,
        mode: 'redis-cluster',
        clusterStatus: 'healthy',
        clusterInfo: {
          nodes: clusterStatus.nodes?.length || 0,
          masterNode: clusterStatus.masterNode
        },
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          profileImage
        }
      });

    } catch (error) {
      console.error('Redis Cluster login error:', error);
      
      // 클러스터 오류 시 인메모리 모드로 fallback
      if (error.code === 'CLUSTERDOWN' || error.code === 'CLUSTERFAIL' || error.code === 'MOVED') {
        console.log('Cluster error detected, falling back to in-memory mode');
        await this.handleInMemoryLogin(req, res, user, { 
          isHealthy: false, 
          mode: 'fallback', 
          error: error.code 
        });
        return;
      }
      
      throw error;
    }
  },

  // 클러스터 환경에서의 중복 로그인 처리
  async handleClusterDuplicateLogin(req, user, existingSession, clusterStatus) {
    try {
      const io = req.app.get('io');
      
      if (!io) {
        // Socket.IO가 없으면 클러스터의 모든 노드에서 기존 세션 제거
        await SessionService.removeAllUserSessionsFromCluster(user._id);
        return { shouldProceed: true };
      }

      // 중복 로그인 알림 (클러스터 정보 포함)
      io.to(existingSession.socketId).emit('duplicate_login', {
        type: 'new_login_attempt',
        deviceInfo: req.headers['user-agent'],
        ipAddress: req.ip,
        timestamp: Date.now(),
        location: req.headers['x-forwarded-for'] || req.connection.remoteAddress,
        browser: req.headers['user-agent'],
        clusterInfo: {
          currentNode: clusterStatus.masterNode,
          totalNodes: clusterStatus.nodes?.length || 0
        }
      });

      // 클러스터 환경에서는 더 짧은 타임아웃 사용 (네트워크 지연 고려)
      const response = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          resolve('force_login_timeout');
        }, 10000); // 10초 타임아웃 (클러스터 환경에서 더 짧게)

        const eventListeners = new Map();

        const cleanup = () => {
          clearTimeout(timeout);
          eventListeners.forEach((listener, event) => {
            io.removeListener(event, listener);
          });
          eventListeners.clear();
        };

        const handleForceLogin = async (data) => {
          try {
            if (data.token === existingSession.token) {
              // 클러스터의 모든 노드에서 세션 제거
              await SessionService.removeSessionFromCluster(user._id, existingSession.sessionId);
              io.to(existingSession.socketId).emit('session_terminated', {
                reason: 'new_login',
                message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.',
                clusterSync: true
              });
              cleanup();
              resolve('force_login');
            } else {
              cleanup();
              reject(new Error('INVALID_TOKEN'));
            }
          } catch (error) {
            cleanup();
            // 클러스터 오류 시에도 세션 제거 시도
            if (error.code === 'CLUSTERDOWN' || error.code === 'MOVED') {
              try {
                await SessionService.removeAllUserSessionsFromCluster(user._id);
                resolve('force_login_cluster_error');
              } catch (fallbackError) {
                reject(fallbackError);
              }
            } else {
              reject(error);
            }
          }
        };

        const handleKeepSession = () => {
          cleanup();
          resolve('keep_existing');
        };

        eventListeners.set('force_login', handleForceLogin);
        eventListeners.set('keep_existing_session', handleKeepSession);
        
        io.once('force_login', handleForceLogin);
        io.once('keep_existing_session', handleKeepSession);
      });

      if (response === 'keep_existing') {
        return {
          shouldProceed: false,
          code: 'DUPLICATE_LOGIN_REJECTED',
          message: '기존 세션을 유지하도록 선택되었습니다.'
        };
      }

      if (response === 'force_login_timeout' || response === 'force_login_cluster_error') {
        console.log('Duplicate login timeout or cluster error, proceeding with automatic session termination');
        await SessionService.removeAllUserSessionsFromCluster(user._id);
      }

      return { shouldProceed: true };

    } catch (error) {
      console.error('Cluster duplicate login handling error:', error);
      
      if (error.message === 'INVALID_TOKEN') {
        return {
          shouldProceed: false,
          code: 'INVALID_TOKEN',
          message: '인증 토큰이 유효하지 않습니다.'
        };
      }

      // 클러스터 오류 시 안전하게 모든 세션 종료
      try {
        await SessionService.removeAllUserSessionsFromCluster(user._id);
      } catch (cleanupError) {
        console.error('Cleanup error after duplicate login failure:', cleanupError);
      }
      
      return { shouldProceed: true };
    }
  },

  async logout(req, res) {
    try {
      const sessionId = req.header('x-session-id');
      if (!sessionId) {
        return res.status(400).json({
          success: false,
          message: '세션 정보가 없습니다.'
        });
      }

      // 클러스터 상태 확인
      const clusterStatus = await SessionService.getClusterStatus();
      
      // 세션 제거 (클러스터/인메모리 모드 자동 처리)
      if (clusterStatus.isHealthy) {
        await SessionService.removeSessionFromCluster(req.user.id, sessionId);
      } else {
        await SessionService.removeSession(req.user.id, sessionId);
      }

      // Socket.IO 클라이언트에 로그아웃 알림
      const io = req.app.get('io');
      if (io) {
        try {
          const socketId = await SessionService.getSocketId(req.user.id, sessionId);
          if (socketId) {
            io.to(socketId).emit('session_ended', {
              reason: 'logout',
              message: '로그아웃되었습니다.',
              clusterMode: clusterStatus.isHealthy
            });
          }
        } catch (socketError) {
          console.error('Socket notification error during logout:', socketError);
        }
      }
      
      res.clearCookie('token');
      res.clearCookie('sessionId');
      
      res.json({
        success: true,
        message: '로그아웃되었습니다.',
        clusterStatus: clusterStatus.isHealthy ? 'healthy' : 'degraded'
      });
    } catch (error) {
      console.error('Logout error:', error);
      res.status(500).json({
        success: false,
        message: '로그아웃 처리 중 오류가 발생했습니다.'
      });
    }
  },

  async verifyToken(req, res) {
    try {
      const token = req.header('x-auth-token');
      const sessionId = req.header('x-session-id');

      if (!token || !sessionId) {
        console.log('Missing token or sessionId:', { token: !!token, sessionId: !!sessionId });
        return res.status(401).json({
          success: false,
          message: '인증 정보가 제공되지 않았습니다.'
        });
      }

      // JWT 토큰 검증
      const decoded = jwt.verify(token, jwtSecret);
      
      if (!decoded?.user?.id || !decoded?.sessionId) {
        return res.status(401).json({
          success: false,
          message: '유효하지 않은 토큰입니다.'
        });
      }

      if (decoded.sessionId !== sessionId) {
        return res.status(401).json({
          success: false,
          message: '세션 정보가 일치하지 않습니다.'
        });
      }

      const user = await User.findById(decoded.user.id);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: '사용자를 찾을 수 없습니다.'
        });
      }

      // 클러스터 상태 확인 및 세션 검증
      const clusterStatus = await SessionService.getClusterStatus();
      
      if (clusterStatus.isHealthy) {
        // 클러스터가 정상인 경우 클러스터 기반 세션 검증
        const validationResult = await SessionService.validateClusterSession(user._id, sessionId);
        if (!validationResult.isValid) {
          console.log('Invalid cluster session:', validationResult);
          return res.status(401).json({
            success: false,
            code: validationResult.error,
            message: validationResult.message
          });
        }

        // 클러스터에서 세션 갱신
        await SessionService.refreshClusterSession(user._id, sessionId);

        if (validationResult.needsProfileRefresh) {
          res.set('X-Profile-Update-Required', 'true');
        }
      } else {
        // 클러스터가 불안정한 경우 기본적인 세션 검증만 수행
        console.log('Cluster degraded, using basic session validation for user:', user._id);
        try {
          const sessionExists = await SessionService.sessionExists(user._id, sessionId);
          if (!sessionExists) {
            return res.status(401).json({
              success: false,
              code: 'SESSION_NOT_FOUND',
              message: '세션을 찾을 수 없습니다.'
            });
          }
        } catch (sessionError) {
          console.error('Session validation error in degraded cluster mode:', sessionError);
        }
      }

      console.log('Token verification successful for user:', user._id);

      const key = user.profileImage;
      let profileImage = `${cloudfrontBaseUrl}/${key}`;

      if (key === '') {
        profileImage = key;
      }

      res.json({
        success: true,
        mode: clusterStatus.isHealthy ? 'redis-cluster' : 'degraded',
        clusterStatus: clusterStatus.isHealthy ? 'healthy' : 'degraded',
        clusterInfo: clusterStatus.isHealthy ? {
          nodes: clusterStatus.nodes?.length || 0,
          masterNode: clusterStatus.masterNode
        } : null,
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          profileImage
        }
      });

    } catch (error) {
      console.error('Token verification error:', error);

      if (error.name === 'JsonWebTokenError') {
        return res.status(401).json({
          success: false,
          message: '유효하지 않은 토큰입니다.'
        });
      }

      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: '토큰이 만료되었습니다.',
          code: 'TOKEN_EXPIRED'
        });
      }

      res.status(500).json({
        success: false,
        message: '토큰 검증 중 오류가 발생했습니다.'
      });
    }
  },

  async refreshToken(req, res) {
    try {
      const oldSessionId = req.header('x-session-id');
      if (!oldSessionId) {
        return res.status(400).json({
          success: false,
          message: '세션 정보가 없습니다.'
        });
      }

      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: '사용자를 찾을 수 없습니다.'
        });
      }

      // 클러스터 상태 확인
      const clusterStatus = await SessionService.getClusterStatus();

      // 이전 세션 제거
      try {
        if (clusterStatus.isHealthy) {
          await SessionService.removeSessionFromCluster(user._id, oldSessionId);
        } else {
          await SessionService.removeSession(user._id, oldSessionId);
        }
      } catch (removeError) {
        console.error('Error removing old session:', removeError);
      }

      // 새 세션 생성
      const sessionInfo = clusterStatus.isHealthy 
        ? await SessionService.createClusterSession(user._id, {
            userAgent: req.headers['user-agent'],
            ipAddress: req.ip,
            deviceInfo: req.headers['user-agent'],
            refreshedAt: Date.now(),
            mode: 'redis-cluster',
            clusterNodes: clusterStatus.nodes || []
          })
        : await SessionService.createSession(user._id, {
            userAgent: req.headers['user-agent'],
            ipAddress: req.ip,
            deviceInfo: req.headers['user-agent'],
            refreshedAt: Date.now(),
            mode: 'in-memory'
          });

      if (!sessionInfo || !sessionInfo.sessionId) {
        throw new Error('Failed to create new session');
      }

      // 새로운 JWT 토큰 생성
      const token = jwt.sign(
        { 
          user: { id: user._id },
          sessionId: sessionInfo.sessionId,
          iat: Math.floor(Date.now() / 1000),
          mode: clusterStatus.isHealthy ? 'redis-cluster' : 'in-memory'
        },
        jwtSecret,
        { 
          expiresIn: '24h',
          algorithm: 'HS256'
        }
      );

      const key = user.profileImage;
      let profileImage = `${cloudfrontBaseUrl}/${key}`;

      if (key === '') {
        profileImage = key;
      }

      res.json({
        success: true,
        message: '토큰이 갱신되었습니다.',
        token,
        sessionId: sessionInfo.sessionId,
        mode: clusterStatus.isHealthy ? 'redis-cluster' : 'in-memory',
        clusterStatus: clusterStatus.isHealthy ? 'healthy' : 'degraded',
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          profileImage
        }
      });

    } catch (error) {
      console.error('Token refresh error:', error);
      res.status(500).json({
        success: false,
        message: '토큰 갱신 중 오류가 발생했습니다.'
      });
    }
  }
};

module.exports = authController;