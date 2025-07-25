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
const redisClient = require("./utils/redisClient");
const SocketStateService = require("./services/socketStateService");

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
app.get("/health", async (req, res) => {
  try {
    // MongoDB 연결 상태 확인
    const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    
    // Redis 클러스터 상태 확인
    const redisHealthy = await SocketStateService.healthCheck();
    
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      env: process.env.NODE_ENV,
      services: {
        mongodb: mongoStatus,
        redis: redisHealthy ? 'connected' : 'disconnected'
      }
    });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({
      status: "error",
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// API 라우트 마운트
app.use("/api", routes);

// Socket.IO 설정
const io = socketIO(server, { cors: corsOptions });

// Redis Adapter 설정 함수
async function setupSocketIORedisAdapter() {
  try {
    // Socket.IO용 Redis 클라이언트 생성 (표준 redis 클라이언트 사용)
    const clusterNodes = process.env.REDIS_CLUSTER_NODES;
    
    if (!clusterNodes) {
      throw new Error('REDIS_CLUSTER_NODES environment variable is not set');
    }

    // 첫 번째 노드를 사용해서 Redis 클라이언트 생성
    const firstNode = clusterNodes.split(',')[0].trim();
    const [host, port] = firstNode.split(':');

    const pubClient = createClient({
      socket: {
        host: host,
        port: parseInt(port)
      },
      password: process.env.REDIS_PASSWORD
    });

    const subClient = pubClient.duplicate();

    // Redis 클라이언트 연결
    await Promise.all([
      pubClient.connect(),
      subClient.connect()
    ]);

    console.log('✅ Socket.IO Redis Adapter clients connected');

    // Redis Adapter 설정
    io.adapter(createAdapter(pubClient, subClient));
    console.log('✅ Socket.IO Redis Adapter configured');

    return { pubClient, subClient };

  } catch (error) {
    console.error('❌ Socket.IO Redis Adapter setup failed:', error);
    console.log('⚠️ Continuing without Redis Adapter (single instance mode)');
    return null;
  }
}

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

// 서버 시작
async function startServer() {
  try {
    // MongoDB 연결
    await mongoose.connect(process.env.MONGO_URI, {
      replicaSet: 'rs0',
      readPreference: 'secondaryPreferred'
    });
    console.log("✅ MongoDB Connected");

    // Redis 클러스터 연결 (애플리케이션 상태용)
    await redisClient.connect();
    console.log("✅ Redis Cluster Connected");

    // Socket.IO Redis Adapter 설정 (다중 인스턴스 통신용)
    const adapterClients = await setupSocketIORedisAdapter();

    // Redis 클러스터 정보 출력
    try {
      const clusterInfo = await redisClient.getClusterInfo();
      console.log("📊 Redis Cluster Info:", clusterInfo.split('\r\n')[0]); // 첫 번째 줄만 출력
      
      const clusterNodes = await redisClient.getClusterNodes();
      const nodeCount = clusterNodes.split('\n').filter(line => line.trim()).length;
      console.log(`📡 Redis Cluster Nodes: ${nodeCount} nodes`);
    } catch (clusterError) {
      console.warn("⚠️ Could not retrieve cluster info:", clusterError.message);
    }

    // 서버 시작
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`📦 Environment: ${process.env.NODE_ENV}`);
      console.log(`📡 API Base URL: http://0.0.0.0:${PORT}/api`);
      console.log(`🔄 Auto-scaling ready with Redis Cluster`);
      if (adapterClients) {
        console.log(`🔗 Socket.IO Redis Adapter enabled for multi-instance communication`);
      }
    });

    // Graceful shutdown을 위해 adapter clients 저장
    global.socketIOAdapterClients = adapterClients;

  } catch (err) {
    console.error("❌ Server startup error:", err);
    process.exit(1);
  }
}

startServer();

// Graceful shutdown 처리
process.on('SIGTERM', async () => {
  console.log('🔄 SIGTERM received, shutting down gracefully...');
  await gracefulShutdown();
});

process.on('SIGINT', async () => {
  console.log('🔄 SIGINT received, shutting down gracefully...');
  await gracefulShutdown();
});

async function gracefulShutdown() {
  try {
    console.log('🔄 Closing server...');
    server.close(() => {
      console.log('✅ HTTP server closed');
    });

    // Socket.IO Adapter Redis 클라이언트 정리
    if (global.socketIOAdapterClients) {
      console.log('🔄 Closing Socket.IO Redis Adapter connections...');
      const { pubClient, subClient } = global.socketIOAdapterClients;
      await Promise.all([
        pubClient.quit(),
        subClient.quit()
      ]);
      console.log('✅ Socket.IO Redis Adapter connections closed');
    }

    console.log('🔄 Closing Redis connection...');
    await redisClient.quit();
    console.log('✅ Redis connection closed');

    console.log('🔄 Closing MongoDB connection...');
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');

    console.log('✅ Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during graceful shutdown:', error);
    process.exit(1);
  }
}

module.exports = { app, server };
