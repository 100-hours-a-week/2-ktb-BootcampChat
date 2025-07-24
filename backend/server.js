require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const http = require("http");
const socketIO = require("socket.io");
const path = require("path");
const { router: roomsRouter, initializeSocket } = require("./routes/api/rooms");
const routes = require("./routes");
const SocketRedisAdapter = require("./utils/socketRedisAdapter"); // 추가

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5001;

// trust proxy 설정 추가
app.set("trust proxy", 1);

// CORS 설정
const corsOptions = {
  origin: [
    'https://bootcampchat-fe.run.goorm.site',
    'https://bootcampchat-hgxbv.dev-k8s.arkain.io',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'https://localhost:3000',
    'https://localhost:3001',
    'https://localhost:3002',
    'http://0.0.0.0:3000',
    'https://0.0.0.0:3000',
    'https://chat.goorm-ktb-002.goorm.team',
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-auth-token",
    "x-session-id",
    "Cache-Control",
    "Pragma",
  ],
  exposedHeaders: ["x-auth-token", "x-session-id"],
};

// 기본 미들웨어
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// OPTIONS 요청에 대한 처리
app.options("*", cors(corsOptions));

// 정적 파일 제공
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// 요청 로깅
if (process.env.NODE_ENV === "development") {
  app.use((req, res, next) => {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`
    );
    next();
  });
}

// 기본 상태 체크
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
  });
});

// API 라우트 마운트
app.use("/api", routes);

// Socket.IO 설정 with Redis Adapter
const io = socketIO(server, { cors: corsOptions });

// Redis Adapter 초기화
let socketRedisAdapter;
const initializeRedisAdapter = async () => {
  try {
    socketRedisAdapter = new SocketRedisAdapter();
    await socketRedisAdapter.initialize(io);
    console.log('✅ Socket.IO Redis Adapter initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize Socket.IO Redis Adapter:', error);
    console.log('🔄 Socket.IO will use in-memory adapter');
  }
};

// Chat 소켓 핸들러 (업데이트된 버전 사용)
require("./sockets/chat")(io);

// Socket.IO 객체 전달
initializeSocket(io);

// 404 에러 핸들러
app.use((req, res) => {
  console.log("404 Error:", req.originalUrl);
  res.status(404).json({
    success: false,
    message: "요청하신 리소스를 찾을 수 없습니다.",
    path: req.originalUrl,
  });
});

// 글로벌 에러 핸들러
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "서버 에러가 발생했습니다.",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

// Graceful shutdown 처리
const gracefulShutdown = async (signal) => {
  console.log(`\n📶 Received ${signal}. Starting graceful shutdown...`);
  
  try {
    // Socket.IO Redis Adapter 정리
    if (socketRedisAdapter) {
      console.log('🔄 Closing Socket.IO Redis Adapter...');
      await socketRedisAdapter.close();
    }

    // Redis 연결 정리
    const redisClient = require('./utils/redisClient');
    console.log('🔄 Closing Redis connections...');
    await redisClient.quit();

    // HTTP 서버 종료
    console.log('🔄 Closing HTTP server...');
    server.close(() => {
      console.log('✅ HTTP server closed');
      process.exit(0);
    });

    // 강제 종료 타임아웃 (30초)
    setTimeout(() => {
      console.error('❌ Forceful shutdown after timeout');
      process.exit(1);
    }, 30000);

  } catch (error) {
    console.error('❌ Error during graceful shutdown:', error);
    process.exit(1);
  }
};

// 시그널 핸들러 등록
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 예상치 못한 에러 처리
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

// 서버 시작
mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("✅ MongoDB Connected");
    
    // Redis Adapter 초기화
    await initializeRedisAdapter();
    
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`📦 Environment: ${process.env.NODE_ENV}`);
      console.log(`📡 API Base URL: http://0.0.0.0:${PORT}/api`);
      console.log(`🔗 Socket.IO with Redis Cluster: ${process.env.REDIS_CLUSTER_NODES ? 'Enabled' : 'Disabled'}`);
      
      // Socket Redis Adapter 상태 확인
      if (socketRedisAdapter) {
        const adapterStatus = socketRedisAdapter.getStatus();
        console.log(`📊 Socket.IO Redis Adapter Status:`, adapterStatus);
      }
    });
  })
  .catch((err) => {
    console.error("❌ Server startup error:", err);
    process.exit(1);
  });

module.exports = { app, server };