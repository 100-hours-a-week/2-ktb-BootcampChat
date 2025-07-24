require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const http = require("http");
const socketIO = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { createClient } = require("redis");
const path = require("path");
const { router: roomsRouter, initializeSocket } = require("./routes/api/rooms");
const routes = require("./routes");

// 캐시 서비스 import 추가
const cacheService = require("./services/cacheService");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5001;
const io = socketIO(server, { cors: corsOptions });
app.set('io', io); // Express 앱에서 io 객체를 참조할 수 있도록 설정

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

const startServer = async () => {
  try {
    // 1. MongoDB 연결
    await mongoose.connect(process.env.MONGO_URI, {
      readPreference: 'secondaryPreferred',
    });
    console.log("MongoDB Connected");

    // 2. Socket.IO 어댑터를 위한 Redis 클라이언트 연결
    const pubClient = createClient({
      url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
      password: process.env.REDIS_PASSWORD,
    });
    const subClient = pubClient.duplicate();

    await Promise.all([pubClient.connect(), subClient.connect()]);
    console.log("Redis clients for Socket.IO adapter connected");

    // 3. Socket.IO 어댑터 설정
    io.adapter(createAdapter(pubClient, subClient));

    // 4. Socket.IO 이벤트 핸들러 및 라우터 초기화
    require("./sockets/chat")(io);
    initializeSocket(io);

    // 5. 캐시 정리 실행
    try {
      console.log("Starting cache cleanup...");
      await cacheService.clearCorruptedCache();
    } catch (error) {
      console.error("Cache cleanup failed:", error);
    }

    // 6. 서버 리스닝 시작
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`📦 Environment: ${process.env.NODE_ENV}`);
      console.log(`📡 API Base URL: http://0.0.0.0:${PORT}/api`);
    });
  } catch (err) {
    console.error("Server startup error:", err);
    process.exit(1);
  }
};

startServer();

module.exports = { app, server };
