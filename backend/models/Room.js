const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const RoomSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  creator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  hasPassword: {
    type: Boolean,
    default: false
  },
  password: {
    type: String,
    select: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  // 정렬 및 조회를 위해 참가자 수를 저장합니다.
  participantsCount: {
    type: Number,
    default: 1,
    index: true
  }
});

// 비밀번호 해싱 미들웨어
RoomSchema.pre('save', async function(next) {
  if (this.isModified('password') && this.password) {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    this.hasPassword = true;
  }
  if (!this.password) {
    this.hasPassword = false;
  }
  next();
});

// 참가자 수가 변경될 때마다 participantsCount 필드를 업데이트합니다.
RoomSchema.pre('save', function(next) {
  if (this.isModified('participants')) {
    this.participantsCount = this.participants.length;
  }
  next();
});

// 비밀번호 확인 메서드
RoomSchema.methods.checkPassword = async function(password) {
  if (!this.hasPassword) return true;
  const room = await this.constructor.findById(this._id).select('+password');
  return await bcrypt.compare(password, room.password);
};

// 쿼리 성능 향상을 위한 인덱스 추가
RoomSchema.index({ createdAt: -1 });
RoomSchema.index({ name: 1 });

module.exports = mongoose.model('Room', RoomSchema);